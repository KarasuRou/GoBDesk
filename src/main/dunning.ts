/**
 * Mahnwesen (light): überfällige, offene Rechnungen ermitteln und eine
 * Zahlungserinnerung/Mahnung als PDF-Anschreiben erzeugen.
 *
 * Ein Mahnschreiben ist KEIN Buchungsbeleg und keine E-Rechnung – es ändert
 * weder die (festgeschriebene) Rechnung noch die EÜR. Fälligkeit = früheste
 * offene Rate eines Ratenplans, sonst `due_date`, sonst Rechnungsdatum + Ziel.
 *
 * Bei Ratenzahlung wird nur der **jetzt fällige** Teil angemahnt, nicht der
 * gesamte Restbetrag – noch nicht fällige Raten bleiben unberührt.
 */

import type Database from "better-sqlite3";

import type { OverdueInvoice } from "../shared/api.js";

const DEFAULT_TERM_DAYS = 14;
const NEW_DEADLINE_DAYS = 10;

function eur(cents: number): string {
  return (
    (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
    " €"
  );
}

function fmt(dateStr: string | null): string {
  if (!dateStr) return "—";
  const p = dateStr.split("-");
  return p.length === 3 ? `${p[2]}.${p[1]}.${p[0]}` : dateStr;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Effektive Fälligkeit: früheste Rate, sonst due_date, sonst Rechnungsdatum + Ziel. */
const EFFECTIVE_DUE_SQL = `COALESCE(
  (SELECT MIN(x.due_date) FROM invoice_installments x WHERE x.invoice_id = i.id),
  i.due_date,
  date(i.issue_date, '+${DEFAULT_TERM_DAYS} days')
)`;

/** Eine Rate mit ihrem Ist-Stand (wie viel davon noch offen ist). */
interface InstallmentStatus {
  seq: number;
  due_date: string;
  amount_cents: number;
  open_cents: number;
  due: boolean; // Fälligkeit erreicht
}

/**
 * Verteilt die tatsächlichen Zahlungen der Reihe nach (FIFO) auf die Soll-Raten.
 * Die Zuordnung ist rein rechnerisch für Fälligkeit/Mahnung – sie verändert
 * keine Buchung: Zufluss bleibt der Zahlungseingang in `payments`.
 */
function installmentStatus(
  db: Database.Database,
  invoiceId: number,
  paidCents: number,
  today: string,
): InstallmentStatus[] {
  const rows = db
    .prepare(
      "SELECT seq, due_date, amount_cents FROM invoice_installments WHERE invoice_id = ? ORDER BY seq",
    )
    .all(invoiceId) as Array<{ seq: number; due_date: string; amount_cents: number }>;
  let rest = Math.max(0, paidCents);
  return rows.map((r) => {
    const covered = Math.min(rest, r.amount_cents);
    rest -= covered;
    return {
      seq: r.seq,
      due_date: r.due_date,
      amount_cents: r.amount_cents,
      open_cents: r.amount_cents - covered,
      due: r.due_date <= today,
    };
  });
}

/** Überfällige Rechnungen: mindestens ein fälliger, noch offener Betrag. */
export function listOverdueInvoices(db: Database.Database): OverdueInvoice[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_number, i.issue_date,
              COALESCE(c.company_name, c.contact_last_name) AS customer_name,
              i.gross_total_cents AS gross,
              COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid,
              COALESCE((SELECT MAX(d.level) FROM dunning_notices d WHERE d.invoice_id = i.id), 0) AS last_level,
              ${EFFECTIVE_DUE_SQL} AS effective_due
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
        WHERE i.status = 'issued'
        ORDER BY effective_due ASC`,
    )
    .all() as Array<{
    id: number;
    invoice_number: string | null;
    issue_date: string | null;
    customer_name: string | null;
    gross: number | null;
    paid: number;
    last_level: number;
    effective_due: string | null;
  }>;

  const today = new Date().toISOString().slice(0, 10);
  const todayMs = Date.parse(today);
  const out: OverdueInvoice[] = [];

  for (const r of rows) {
    const open = (r.gross ?? 0) - r.paid;
    if (open <= 0) continue;

    const inst = installmentStatus(db, r.id, r.paid, today);
    const hasPlan = inst.length > 0;
    // Bei Ratenplan zählt nur, was bereits fällig und noch offen ist.
    const dueNow = hasPlan
      ? inst.filter((x) => x.due).reduce((a, x) => a + x.open_cents, 0)
      : r.effective_due && r.effective_due < today
        ? open
        : 0;
    if (dueNow <= 0) continue;

    const refDue = hasPlan
      ? (inst.find((x) => x.open_cents > 0 && x.due)?.due_date ?? r.effective_due)
      : r.effective_due;
    if (!refDue) continue;

    out.push({
      id: r.id,
      invoice_number: r.invoice_number,
      customer_name: r.customer_name,
      due_date: refDue,
      days_overdue: Math.max(0, Math.floor((todayMs - Date.parse(refDue)) / 86_400_000)),
      gross_cents: r.gross ?? 0,
      paid_cents: r.paid,
      open_cents: open,
      due_now_cents: dueNow,
      installment_count: inst.length,
      last_level: r.last_level,
      next_level: Math.min(r.last_level + 1, 3),
    });
  }
  return out;
}

/** Hält fest, dass für eine Rechnung ein Mahnschreiben der Stufe `level`
 *  erzeugt wurde – Grundlage für die Eskalation auf die nächste Stufe. */
export function recordDunning(
  db: Database.Database,
  invoiceId: number,
  level: number,
  feeCents: number,
  documentId: number | null,
): void {
  db.prepare(
    "INSERT INTO dunning_notices (invoice_id, level, fee_cents, document_id, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(invoiceId, level, Math.max(0, feeCents), documentId, new Date().toISOString());
}

const LEVELS: Record<number, { title: string; intro: string }> = {
  1: {
    title: "Zahlungserinnerung",
    intro:
      "sicher haben Sie es nur übersehen – der folgende Betrag ist noch offen. " +
      "Wir möchten Sie freundlich an den Ausgleich erinnern.",
  },
  2: {
    title: "1. Mahnung",
    intro:
      "trotz unserer Rechnung ist der folgende Betrag bislang nicht bei uns eingegangen. " +
      "Wir bitten Sie, ihn nun zeitnah zu begleichen.",
  },
  3: {
    title: "2. Mahnung",
    intro:
      "leider konnten wir bis heute keinen Zahlungseingang feststellen. Wir fordern Sie " +
      "letztmalig auf, den offenen Betrag umgehend auszugleichen.",
  },
};

/* DESIGN: Mahnschreiben als schlichter, seriöser Geschäftsbrief in Anlehnung an
   DIN 5008 – schmale Absenderzeile oben, Empfängerblock links, Ort/Datum rechts,
   dann Betreff als Überschrift. Beträge in einer rechtsbündigen Tabelle mit
   Trennlinie über der Endsumme; der Ratenplan als eigene, ruhige Tabelle mit
   Status-Spalte. Keine Farben außer dezentem Grau – das Dokument geht an Kunden
   und soll sachlich statt werblich wirken. */
const PRINT_CSS = `
  body { font: 11pt/1.55 "Segoe UI", system-ui, sans-serif; color: #1a1d21; margin: 0; }
  .sender { font-size: 8pt; color: #6b7280; border-bottom: 0.5pt solid #b6bcc4; padding-bottom: 2pt; margin-bottom: 24pt; }
  .recipient { margin-bottom: 22pt; }
  .meta { text-align: right; margin-bottom: 16pt; font-size: 10pt; }
  h1 { font-size: 14pt; margin: 0 0 12pt; }
  h2 { font-size: 11pt; margin: 16pt 0 4pt; }
  p { margin: 0 0 9pt; }
  table { border-collapse: collapse; margin: 10pt 0; }
  table.sum { min-width: 62%; }
  table.sum td { padding: 3pt 10pt 3pt 0; }
  table.sum td.amt { text-align: right; font-variant-numeric: tabular-nums; }
  table.sum tr.total td { border-top: 1pt solid #1a1d21; font-weight: 700; }
  table.plan { width: 100%; font-size: 10pt; }
  table.plan th, table.plan td { border-bottom: 0.5pt solid #d3d7dc; padding: 3pt 6pt 3pt 0; text-align: left; }
  table.plan th { color: #6b7280; font-weight: 600; }
  table.plan td.amt { text-align: right; font-variant-numeric: tabular-nums; }
  .bank { margin-top: 16pt; font-size: 9.5pt; color: #374151; }
  .note { font-size: 9.5pt; color: #6b7280; }
`;

export interface DunningDocument {
  html: string;
  number: string;
  customerId: number;
  orderId: number | null;
  dueNowCents: number;
  title: string;
}

/** Baut das Mahnschreiben-HTML + die Metadaten für die automatische Ablage. */
export function renderDunningHtml(
  db: Database.Database,
  invoiceId: number,
  level: number,
  feeCents: number,
): DunningDocument {
  const s = db
    .prepare(
      "SELECT legal_name, address_line1, zip, city, iban, bic FROM company_settings WHERE id = 1",
    )
    .get() as
    | { legal_name: string; address_line1: string; zip: string; city: string; iban: string | null; bic: string | null }
    | undefined;

  const inv = db
    .prepare(
      `SELECT i.invoice_number, i.issue_date, i.gross_total_cents AS gross, i.customer_id, i.order_id,
              i.buyer_name_snapshot AS buyer_name, i.buyer_address_snapshot AS buyer_addr,
              COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid,
              ${EFFECTIVE_DUE_SQL} AS effective_due
         FROM invoices i WHERE i.id = ?`,
    )
    .get(invoiceId) as
    | {
        invoice_number: string | null;
        issue_date: string | null;
        gross: number | null;
        customer_id: number;
        order_id: number | null;
        buyer_name: string | null;
        buyer_addr: string | null;
        paid: number;
        effective_due: string | null;
      }
    | undefined;

  if (!s || !inv) throw new Error("Rechnung oder Firmendaten nicht gefunden.");

  const cust = db
    .prepare(
      "SELECT COALESCE(company_name, contact_last_name) AS name, address_line1, zip, city FROM customers WHERE id = ?",
    )
    .get(inv.customer_id) as
    | { name: string | null; address_line1: string | null; zip: string | null; city: string | null }
    | undefined;

  const buyerName = inv.buyer_name ?? cust?.name ?? "—";
  const buyerAddr =
    inv.buyer_addr ??
    [cust?.address_line1, [cust?.zip, cust?.city].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  const lvl = LEVELS[level] ?? LEVELS[1];
  const fee = Math.max(0, feeCents);
  const open = (inv.gross ?? 0) - inv.paid;
  const today = new Date().toISOString().slice(0, 10);
  const newDeadline = new Date(Date.now() + NEW_DEADLINE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const num = inv.invoice_number ?? `#${invoiceId}`;

  const inst = installmentStatus(db, invoiceId, inv.paid, today);
  const hasPlan = inst.length > 0;
  const dueNow = hasPlan ? inst.filter((x) => x.due).reduce((a, x) => a + x.open_cents, 0) : open;
  const overdueRates = inst.filter((x) => x.due && x.open_cents > 0);
  const totalDue = dueNow + fee;

  // Betragsaufstellung: bei Ratenzahlung wird nur der fällige Teil gefordert.
  const rows = [
    `<tr><td>Rechnung ${escapeHtml(num)} vom ${fmt(inv.issue_date)}</td><td class="amt">${eur(inv.gross ?? 0)}</td></tr>`,
  ];
  if (inv.paid !== 0) rows.push(`<tr><td>bereits gezahlt</td><td class="amt">−${eur(inv.paid)}</td></tr>`);
  rows.push(`<tr><td>offener Gesamtbetrag</td><td class="amt">${eur(open)}</td></tr>`);
  if (hasPlan) {
    rows.push(
      `<tr><td>davon <strong>jetzt fällig</strong>${
        overdueRates.length > 0
          ? ` (Rate ${overdueRates.map((x) => x.seq).join(", ")})`
          : ""
      }</td><td class="amt">${eur(dueNow)}</td></tr>`,
    );
  }
  if (fee > 0) rows.push(`<tr><td>Mahngebühr</td><td class="amt">${eur(fee)}</td></tr>`);
  rows.push(
    `<tr class="total"><td>zu zahlen bis ${fmt(newDeadline)}</td><td class="amt">${eur(totalDue)}</td></tr>`,
  );

  const planTable = hasPlan
    ? `<h2>Vereinbarter Ratenplan</h2>
       <table class="plan">
         <tr><th>Rate</th><th>fällig am</th><th class="amt">Betrag</th><th class="amt">offen</th><th>Status</th></tr>
         ${inst
           .map(
             (x) => `<tr>
               <td>${x.seq}.</td>
               <td>${fmt(x.due_date)}</td>
               <td class="amt">${eur(x.amount_cents)}</td>
               <td class="amt">${eur(x.open_cents)}</td>
               <td>${
                 x.open_cents === 0 ? "bezahlt" : x.due ? "überfällig" : "noch nicht fällig"
               }</td>
             </tr>`,
           )
           .join("")}
       </table>
       <p class="note">Noch nicht fällige Raten bleiben von diesem Schreiben unberührt.</p>`
    : "";

  const bank = s.iban
    ? `<div class="bank">Bitte überweisen Sie auf: IBAN ${escapeHtml(s.iban)}${
        s.bic ? ` · BIC ${escapeHtml(s.bic)}` : ""
      }. Verwendungszweck: ${escapeHtml(num)}.</div>`
    : "";

  const feeNote =
    fee > 0
      ? `<p class="note">Die Mahngebühr ist Verzugsschaden und daher ohne Umsatzsteuer ausgewiesen.</p>`
      : "";

  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>${escapeHtml(lvl.title)} ${escapeHtml(num)}</title><style>${PRINT_CSS}</style></head><body>
  <div class="sender">${escapeHtml(s.legal_name)} · ${escapeHtml(s.address_line1)} · ${escapeHtml(s.zip)} ${escapeHtml(s.city)}</div>
  <div class="recipient">${escapeHtml(buyerName)}<br>${escapeHtml(buyerAddr)}</div>
  <div class="meta">${escapeHtml(s.city)}, ${fmt(today)}</div>
  <h1>${escapeHtml(lvl.title)} zu Rechnung ${escapeHtml(num)}</h1>
  <p>Sehr geehrte Damen und Herren,</p>
  <p>${lvl.intro}</p>
  <table class="sum">${rows.join("")}</table>
  ${planTable}
  <p>Die Fälligkeit war der ${fmt(hasPlan ? (overdueRates[0]?.due_date ?? inv.effective_due) : inv.effective_due)}.
     Sollte sich Ihre Zahlung mit diesem Schreiben überschnitten haben, betrachten Sie es bitte
     als gegenstandslos.</p>
  ${feeNote}
  ${bank}
  <p style="margin-top:18pt;">Mit freundlichen Grüßen<br>${escapeHtml(s.legal_name)}</p>
</body></html>`;

  return {
    html,
    number: num,
    customerId: inv.customer_id,
    orderId: inv.order_id,
    dueNowCents: dueNow,
    title: `${lvl.title} ${num}`,
  };
}
