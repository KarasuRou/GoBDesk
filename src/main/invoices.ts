/** Rechnungs-Datenzugriff: Entwürfe, Liste, Festschreibung inkl. ZUGFeRD-PDF. */

import { readFileSync, rmSync } from "node:fs";

import type Database from "better-sqlite3";

import { appendAudit, cancelInvoice as gobdCancel, issueInvoice as gobdIssue } from "../core/gobd.js";
import { fileDigest } from "./hash.js";
import type {
  CancelInvoiceResult,
  DraftInvoiceInput,
  InvoiceDetail,
  InvoiceFilter,
  InvoiceItemDetail,
  InvoiceListItem,
  IssueInvoiceResult,
  LineAdjustment,
  PaymentItem,
  TaxRate,
} from "../shared/api.js";
import { previewInvoicePdf, renderInvoicePdf } from "./sidecar.js";

export interface SidecarPaths {
  invoicesDir: string;
  sidecarDir: string;
}

/** Baut aus DB-Rohwerten (Typ/Wert/Grund) einen Zu-/Abschlag oder null. */
function rowAdjustment(type: unknown, value: unknown, reason: unknown): LineAdjustment | null {
  if ((type === "percent" || type === "amount") && typeof value === "number") {
    return { type, value, reason: (reason as string | null) ?? null };
  }
  return null;
}

/** Zerlegt einen Zu-/Abschlag in die drei DB-Spalten (Typ, Wert, Grund). */
function adjCols(
  a: LineAdjustment | null | undefined,
): [string | null, number | null, string | null] {
  return a ? [a.type, a.value, a.reason ?? null] : [null, null, null];
}

export function listTaxRates(db: Database.Database): TaxRate[] {
  return db
    .prepare(
      "SELECT id, name, rate_bp, is_default FROM tax_rates WHERE is_active = 1 ORDER BY rate_bp DESC",
    )
    .all() as TaxRate[];
}

export function listInvoices(
  db: Database.Database,
  filter: InvoiceFilter = {},
): InvoiceListItem[] {
  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (filter.customerId) {
    where.push("i.customer_id = @customerId");
    params.customerId = filter.customerId;
  }
  if (filter.from) {
    where.push("i.issue_date >= @from");
    params.from = filter.from;
  }
  if (filter.to) {
    where.push("i.issue_date <= @to");
    params.to = filter.to;
  }
  if (filter.orderId != null) {
    where.push("i.order_id = @orderId");
    params.orderId = filter.orderId;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const stmt = db.prepare(
    `SELECT i.id, i.invoice_number, i.status, i.issue_date, i.gross_total_cents,
            i.cancels_invoice_id,
            COALESCE(c.company_name, c.contact_last_name) AS customer_name,
            EXISTS (SELECT 1 FROM invoice_artifacts a WHERE a.invoice_id = i.id AND a.kind = 'pdf') AS has_pdf,
            COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0) AS paid_cents,
            CASE WHEN COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.invoice_id = i.id), 0)
                      >= COALESCE(i.gross_total_cents, 999999999999) THEN 1 ELSE 0 END AS is_paid
       FROM invoices i
       JOIN customers c ON c.id = i.customer_id
       ${whereSql}
      ORDER BY i.id DESC`,
  );
  return (Object.keys(params).length ? stmt.all(params) : stmt.all()) as InvoiceListItem[];
}

/** Markiert eine festgeschriebene Rechnung als (voll) bezahlt: erfasst den Restbetrag als Zahlung. */
export function markInvoicePaid(db: Database.Database, invoiceId: number): void {
  const inv = db
    .prepare("SELECT gross_total_cents AS gross, status FROM invoices WHERE id = ?")
    .get(invoiceId) as { gross: number | null; status: string } | undefined;
  if (!inv || inv.status !== "issued" || inv.gross == null) {
    throw new Error("Nur festgeschriebene Rechnungen können als bezahlt markiert werden.");
  }
  const paid = (
    db
      .prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM payments WHERE invoice_id = ?")
      .get(invoiceId) as { s: number }
  ).s;
  const remaining = inv.gross - paid;
  if (remaining <= 0) return;
  addPayment(db, invoiceId, new Date().toISOString().slice(0, 10), remaining, "Restbetrag");
}

/** Vollständige Rechnungsdetails inkl. Positionen, Zahlungen und Zahlungsstatus. */
export function getInvoice(db: Database.Database, id: number): InvoiceDetail | null {
  const head = db
    .prepare(
      `SELECT i.id, i.invoice_number, i.status, i.issue_date, i.service_date, i.customer_id, i.notes,
              i.order_id, o.order_number,
              i.cancelled_by_invoice_id, cb.invoice_number AS cancelled_by_number,
              i.cancels_invoice_id, cv.invoice_number AS cancels_number,
              i.discount_type, i.discount_value, i.discount_reason,
              i.net_total_cents, i.tax_total_cents, i.gross_total_cents,
              COALESCE(c.company_name, c.contact_last_name) AS customer_name,
              EXISTS (SELECT 1 FROM invoice_artifacts a WHERE a.invoice_id = i.id AND a.kind = 'pdf') AS has_pdf
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN orders o ON o.id = i.order_id
         LEFT JOIN invoices cb ON cb.id = i.cancelled_by_invoice_id
         LEFT JOIN invoices cv ON cv.id = i.cancels_invoice_id
        WHERE i.id = ?`,
    )
    .get(id) as
    | (Omit<
        InvoiceDetail,
        "items" | "payments" | "paid_cents" | "remaining_cents" | "payment_status" | "discount"
      > & {
        discount_type: string | null;
        discount_value: number | null;
        discount_reason: string | null;
      })
    | undefined;
  if (!head) return null;

  const rawItems = db
    .prepare(
      `SELECT position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp,
              discount_type, discount_value, discount_reason,
              surcharge_type, surcharge_value, surcharge_reason,
              line_net_cents, line_gross_cents
         FROM invoice_items WHERE invoice_id = ? ORDER BY position`,
    )
    .all(id) as Array<
    Omit<InvoiceItemDetail, "discount" | "surcharge"> & {
      discount_type: string | null;
      discount_value: number | null;
      discount_reason: string | null;
      surcharge_type: string | null;
      surcharge_value: number | null;
      surcharge_reason: string | null;
    }
  >;
  const items: InvoiceItemDetail[] = rawItems.map((r) => {
    const {
      discount_type,
      discount_value,
      discount_reason,
      surcharge_type,
      surcharge_value,
      surcharge_reason,
      ...rest
    } = r;
    return {
      ...rest,
      discount: rowAdjustment(discount_type, discount_value, discount_reason),
      surcharge: rowAdjustment(surcharge_type, surcharge_value, surcharge_reason),
    };
  });
  const payments = db
    .prepare(
      "SELECT id, paid_at, amount_cents, method, note FROM payments WHERE invoice_id = ? ORDER BY paid_at, id",
    )
    .all(id) as PaymentItem[];

  const paid = payments.reduce((sum, p) => sum + p.amount_cents, 0);
  const gross = head.gross_total_cents ?? 0;
  const remaining = Math.max(0, gross - paid);
  const paymentStatus = gross > 0 && paid >= gross ? "bezahlt" : paid > 0 ? "teilweise" : "offen";

  const { discount_type, discount_value, discount_reason, ...headRest } = head;
  return {
    ...headRest,
    discount: rowAdjustment(discount_type, discount_value, discount_reason),
    items,
    payments,
    paid_cents: paid,
    remaining_cents: remaining,
    payment_status: paymentStatus,
  };
}

/** Erfasst eine (Teil-)Zahlung mit eigenem Datum – Grundlage für Ratenzahlungen. */
export function addPayment(
  db: Database.Database,
  invoiceId: number,
  paidAt: string,
  amountCents: number,
  note: string | null,
): void {
  const inv = db.prepare("SELECT status FROM invoices WHERE id = ?").get(invoiceId) as
    | { status: string }
    | undefined;
  // Auch stornierte Rechnungen erlauben negative Zahlungen (Rückzahlung nach Storno).
  if (!inv || (inv.status !== "issued" && inv.status !== "cancelled")) {
    throw new Error("Zahlungen sind nur für festgeschriebene Rechnungen möglich.");
  }
  if (!paidAt) throw new Error("Bitte ein Zahlungsdatum angeben.");
  if (amountCents === 0) throw new Error("Der Betrag darf nicht 0 sein.");
  const run = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO payments (invoice_id, paid_at, amount_cents, method, note) VALUES (?, ?, ?, 'manuell', ?)",
      )
      .run(invoiceId, paidAt, amountCents, note);
    // Zufluss (EÜR-relevanter Geschäftsvorfall) im Journal nachvollziehbar machen.
    appendAudit(db, "payment", Number(info.lastInsertRowid), "ADD", {
      invoice_id: invoiceId,
      amount_cents: amountCents,
      paid_at: paidAt,
    });
  });
  run();
}

/** Löscht eine Zahlung und protokolliert die Korrektur in der Audit-Kette (GoBD). */
export function deletePayment(db: Database.Database, paymentId: number): void {
  const p = db.prepare("SELECT invoice_id, amount_cents FROM payments WHERE id = ?").get(paymentId) as
    | { invoice_id: number; amount_cents: number }
    | undefined;
  if (!p) return;
  const run = db.transaction(() => {
    db.prepare("DELETE FROM payments WHERE id = ?").run(paymentId);
    appendAudit(db, "payment", paymentId, "DELETE", {
      invoice_id: p.invoice_id,
      amount_cents: p.amount_cents,
    });
  });
  run();
}

export function createDraftInvoice(db: Database.Database, input: DraftInvoiceInput): number {
  if (input.lines.length === 0) throw new Error("Mindestens eine Position erforderlich.");

  const run = db.transaction((data: DraftInvoiceInput): number => {
    const [dt, dv, dr] = adjCols(data.discount);
    const invId = Number(
      db
        .prepare(
          `INSERT INTO invoices (customer_id, status, issue_date, service_date, notes, order_id,
                                 discount_type, discount_value, discount_reason)
           VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.customer_id,
          data.issue_date,
          data.service_date,
          data.payment_terms,
          data.order_id ?? null,
          dt,
          dv,
          dr,
        )
        .lastInsertRowid,
    );
    const item = db.prepare(
      `INSERT INTO invoice_items (invoice_id, position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp,
                                  discount_type, discount_value, discount_reason, surcharge_type, surcharge_value, surcharge_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    data.lines.forEach((l, i) => {
      const d = adjCols(l.discount);
      const s = adjCols(l.surcharge);
      item.run(
        invId, i + 1, l.description, l.quantity_milli, l.unit, l.unit_price_net_cents, l.tax_rate_bp,
        d[0], d[1], d[2], s[0], s[1], s[2],
      );
    });
    return invId;
  });

  return run(input);
}

/** Aktualisiert einen Entwurf (nur Status 'draft'); ersetzt Kopf + Positionen. */
export function updateDraftInvoice(
  db: Database.Database,
  id: number,
  input: DraftInvoiceInput,
): void {
  if (input.lines.length === 0) throw new Error("Mindestens eine Position erforderlich.");
  const inv = db.prepare("SELECT status FROM invoices WHERE id = ?").get(id) as
    | { status: string }
    | undefined;
  if (!inv) throw new Error("Rechnung nicht gefunden.");
  if (inv.status !== "draft") throw new Error("Nur Entwürfe können bearbeitet werden.");

  const run = db.transaction(() => {
    const [dt, dv, dr] = adjCols(input.discount);
    db.prepare(
      `UPDATE invoices SET customer_id = ?, issue_date = ?, service_date = ?, notes = ?, order_id = ?,
                           discount_type = ?, discount_value = ?, discount_reason = ?, updated_at = ?
         WHERE id = ?`,
    ).run(
      input.customer_id,
      input.issue_date,
      input.service_date,
      input.payment_terms,
      input.order_id ?? null,
      dt,
      dv,
      dr,
      new Date().toISOString(),
      id,
    );
    db.prepare("DELETE FROM invoice_items WHERE invoice_id = ?").run(id);
    const item = db.prepare(
      `INSERT INTO invoice_items (invoice_id, position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp,
                                  discount_type, discount_value, discount_reason, surcharge_type, surcharge_value, surcharge_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    input.lines.forEach((l, i) => {
      const d = adjCols(l.discount);
      const s = adjCols(l.surcharge);
      item.run(
        id, i + 1, l.description, l.quantity_milli, l.unit, l.unit_price_net_cents, l.tax_rate_bp,
        d[0], d[1], d[2], s[0], s[1], s[2],
      );
    });
  });
  run();
}

interface Row {
  [key: string]: unknown;
}

function buildSidecarRequest(db: Database.Database, invoiceId: number, outputDir: string): unknown {
  const inv = db
    .prepare(
      `SELECT i.invoice_number, i.issue_date, i.service_date, i.due_date, i.currency,
              i.is_kleinunternehmer_snapshot AS ku, i.notes, i.customer_id, i.order_number_snapshot,
              i.discount_type, i.discount_value, i.discount_reason,
              cv.invoice_number AS cancels_number
         FROM invoices i LEFT JOIN invoices cv ON cv.id = i.cancels_invoice_id
        WHERE i.id = ?`,
    )
    .get(invoiceId) as Row;
  const s = db.prepare("SELECT * FROM company_settings WHERE id = 1").get() as Row;
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(inv.customer_id) as Row;
  const items = db
    .prepare(
      `SELECT description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp,
              discount_type, discount_value, discount_reason,
              surcharge_type, surcharge_value, surcharge_reason
         FROM invoice_items WHERE invoice_id = ? ORDER BY position`,
    )
    .all(invoiceId) as Row[];

  return {
    command: "render",
    profile: "en16931",
    output_dir: outputDir,
    invoice: {
      number: inv.invoice_number,
      issue_date: inv.issue_date,
      service_date: inv.service_date,
      due_date: inv.due_date,
      currency: inv.currency ?? "EUR",
      is_kleinunternehmer: inv.ku === 1,
      seller: {
        name: s.legal_name,
        street: s.address_line1,
        zip: s.zip,
        city: s.city,
        country: s.country_iso,
        vat_id: s.vat_id,
        tax_number: s.tax_number,
        email: s.email,
        iban: s.iban,
        bic: s.bic,
      },
      buyer: {
        name: c.company_name ?? c.contact_last_name,
        street: c.address_line1,
        zip: c.zip,
        city: c.city,
        country: c.country_iso,
        vat_id: c.vat_id,
        email: c.email,
      },
      lines: items.map((r) => ({
        description: r.description,
        quantity_milli: r.quantity_milli,
        unit: r.unit,
        unit_price_net_cents: r.unit_price_net_cents,
        tax_rate_bp: r.tax_rate_bp,
        discount: rowAdjustment(r.discount_type, r.discount_value, r.discount_reason),
        surcharge: rowAdjustment(r.surcharge_type, r.surcharge_value, r.surcharge_reason),
      })),
      discount: rowAdjustment(inv.discount_type, inv.discount_value, inv.discount_reason),
      payment_terms: inv.notes ?? null,
      order_number: inv.order_number_snapshot ?? null,
      cancels_number: inv.cancels_number ?? null,
    },
  };
}

/** Baut die Vorschau-Anfrage aus dem (ungespeicherten) Editor-Zustand. */
function buildPreviewRequest(
  db: Database.Database,
  input: DraftInvoiceInput,
  outputDir: string,
): unknown {
  const s = db.prepare("SELECT * FROM company_settings WHERE id = 1").get() as Row;
  const c = db.prepare("SELECT * FROM customers WHERE id = ?").get(input.customer_id) as
    | Row
    | undefined;
  const orderNumber =
    input.order_id != null
      ? ((db.prepare("SELECT order_number FROM orders WHERE id = ?").get(input.order_id) as
          | { order_number: string }
          | undefined)?.order_number ?? null)
      : null;
  return {
    command: "preview",
    output_dir: outputDir,
    invoice: {
      number: "VORSCHAU",
      issue_date: input.issue_date,
      service_date: input.service_date,
      due_date: null,
      currency: "EUR",
      is_kleinunternehmer: s.is_kleinunternehmer === 1,
      seller: {
        name: s.legal_name,
        street: s.address_line1,
        zip: s.zip,
        city: s.city,
        country: s.country_iso,
        vat_id: s.vat_id,
        tax_number: s.tax_number,
        email: s.email,
        iban: s.iban,
        bic: s.bic,
      },
      buyer: c
        ? {
            name: c.company_name ?? c.contact_last_name,
            street: c.address_line1,
            zip: c.zip,
            city: c.city,
            country: c.country_iso,
            vat_id: c.vat_id,
            email: c.email,
          }
        : { name: "—", street: null, zip: null, city: null, country: "DE", vat_id: null, email: null },
      lines: input.lines,
      discount: input.discount ?? null,
      payment_terms: input.payment_terms ?? null,
      order_number: orderNumber,
    },
  };
}

/** Erzeugt eine schnelle PDF-Vorschau (Basis-Layout) und liefert die Bytes. */
export async function previewDraftPdf(
  db: Database.Database,
  input: DraftInvoiceInput,
  sidecarDir: string,
  outputDir: string,
): Promise<Uint8Array> {
  const res = await previewInvoicePdf(buildPreviewRequest(db, input, outputDir), sidecarDir);
  if (!res.ok || !res.pdf_path) throw new Error(res.error ?? "Vorschau fehlgeschlagen.");
  const bytes = readFileSync(res.pdf_path);
  try {
    rmSync(res.pdf_path);
  } catch {
    /* temporäre Vorschau-Datei */
  }
  return bytes;
}

/**
 * Schreibt eine Entwurfs-Rechnung fest (GoBD) und erzeugt anschließend das
 * hybride ZUGFeRD-PDF über den Sidecar. Die Festschreibung ist bindend; schlägt
 * nur die PDF-Erzeugung fehl, bleibt die Rechnung festgeschrieben (Neu-Erzeugung
 * später möglich).
 */
export async function issueInvoiceWithPdf(
  db: Database.Database,
  invoiceId: number,
  paths: SidecarPaths,
): Promise<IssueInvoiceResult> {
  const res = gobdIssue(db, invoiceId);
  const sc = await renderAndStoreArtifacts(db, invoiceId, paths);

  const totals = db
    .prepare(
      "SELECT net_total_cents, tax_total_cents, gross_total_cents FROM invoices WHERE id = ?",
    )
    .get(invoiceId) as {
    net_total_cents: number;
    tax_total_cents: number;
    gross_total_cents: number;
  };

  const result: IssueInvoiceResult = {
    invoiceNumber: res.invoiceNumber,
    contentHash: res.contentHash,
    ...totals,
    pdf_path: sc.pdfPath,
    xml_path: sc.xmlPath,
  };

  if (!sc.ok) {
    throw Object.assign(
      new Error(
        `Rechnung ${res.invoiceNumber} festgeschrieben, aber PDF fehlgeschlagen: ${sc.error ?? "unbekannt"}`,
      ),
      { result },
    );
  }
  return result;
}

/** Erzeugt PDF/XML über den Sidecar, speichert Pfade + SHA-256 in
 * invoice_artifacts und verankert die Prüfsummen als ARTIFACTS-Journaleintrag. */
async function renderAndStoreArtifacts(
  db: Database.Database,
  invoiceId: number,
  paths: SidecarPaths,
): Promise<{ ok: boolean; pdfPath: string | null; xmlPath: string | null; error?: string }> {
  const request = buildSidecarRequest(db, invoiceId, paths.invoicesDir);
  const sc = await renderInvoicePdf(request, paths.sidecarDir);
  if (!sc.ok || !sc.pdf_path) return { ok: false, pdfPath: null, xmlPath: null, error: sc.error };

  const pdfPath = sc.pdf_path;
  const xmlPath = sc.xml_path ?? null;
  const upsert = db.prepare(
    `INSERT INTO invoice_artifacts (invoice_id, kind, path, sha256, byte_size) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(invoice_id, kind) DO UPDATE SET
       path = excluded.path, sha256 = excluded.sha256, byte_size = excluded.byte_size`,
  );
  // Prüfsummen der erzeugten Dateien speichern und zusätzlich revisionssicher
  // im Journal verankern (Manipulation der Soll-Hashes bräche die Hash-Kette).
  const pdfDigest = fileDigest(pdfPath);
  upsert.run(invoiceId, "pdf", pdfPath, pdfDigest.sha256, pdfDigest.bytes);
  const artifactAudit: Record<string, unknown> = {
    pdf_sha256: pdfDigest.sha256,
    pdf_bytes: pdfDigest.bytes,
  };
  if (xmlPath) {
    const xmlDigest = fileDigest(xmlPath);
    upsert.run(invoiceId, "xml", xmlPath, xmlDigest.sha256, xmlDigest.bytes);
    artifactAudit.xml_sha256 = xmlDigest.sha256;
    artifactAudit.xml_bytes = xmlDigest.bytes;
  }
  appendAudit(db, "invoice", invoiceId, "ARTIFACTS", artifactAudit);
  return { ok: true, pdfPath, xmlPath };
}

/**
 * Storniert eine festgeschriebene Rechnung (GoBD-konform per Stornobeleg) und
 * erzeugt für die Stornorechnung das ZUGFeRD-PDF. Der Storno ist mit der
 * DB-Transaktion bindend; scheitert nur die PDF-Erzeugung, kann sie später
 * erneut angestoßen werden.
 */
export async function cancelInvoiceWithPdf(
  db: Database.Database,
  invoiceId: number,
  reason: string | null,
  paths: SidecarPaths,
): Promise<CancelInvoiceResult> {
  const res = gobdCancel(db, invoiceId, reason);
  const sc = await renderAndStoreArtifacts(db, res.stornoId, paths);

  const result: CancelInvoiceResult = {
    stornoId: res.stornoId,
    stornoNumber: res.stornoNumber,
    originalNumber: res.originalNumber,
    pdf_path: sc.pdfPath,
  };
  if (!sc.ok) {
    throw Object.assign(
      new Error(
        `Rechnung ${res.originalNumber} storniert (Stornobeleg ${res.stornoNumber}), aber PDF fehlgeschlagen: ${sc.error ?? "unbekannt"}`,
      ),
      { result },
    );
  }
  return result;
}

export function artifactPath(
  db: Database.Database,
  invoiceId: number,
  kind: "pdf" | "xml",
): string | null {
  const row = db
    .prepare("SELECT path FROM invoice_artifacts WHERE invoice_id = ? AND kind = ?")
    .get(invoiceId, kind) as { path: string } | undefined;
  return row?.path ?? null;
}
