/**
 * GoBD-Kernlogik: Festschreibung von Rechnungen + revisionssichere Audit-Kette.
 * Portierung von src-tauri/src/gobd.rs. Die atomare Transaktion ist mit
 * better-sqlite3 (synchron) trivial korrekt: wirft der Sperr-Trigger, rollt die
 * gesamte Festschreibung zurück.
 */

import { createHash } from "node:crypto";

import type Database from "better-sqlite3";

import type { GobdQuickCheck, GobdReport, JournalEntry } from "../shared/api.js";
import { computeInvoiceTotals, roundDiv, type LineInput } from "./tax.js";

export class GobdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GobdError";
  }
}

export interface IssueResult {
  invoiceId: number;
  invoiceNumber: string;
  contentHash: string;
  auditId: number | bigint;
}

/** Aktuelles Format des content_hash (siehe invoiceContentHash / Migrationen 0005/0006/0008). */
export const INVOICE_HASH_VERSION = 4;

/** Kerndaten, aus denen der revisionssichere Rechnungs-Hash gebildet wird. */
export interface InvoiceHashFields {
  /** Formatversion: 1 = Basis, 2 = inkl. Auftragsnummer, 3 = inkl. Storno-Referenz,
   *  4 = inkl. Käuferanschrift. */
  version: number;
  number: string;
  issueDate: string;
  customerId: number;
  customerName: string;
  netTotalCents: number;
  taxTotalCents: number;
  grossTotalCents: number;
  isKleinunternehmer: boolean;
  orderNumber?: string | null;
  /** Nummer der stornierten Originalrechnung (nur bei Stornorechnungen). */
  cancelsNumber?: string | null;
  /** Rechnungsanschrift des Käufers zum Festschreibe-Zeitpunkt (GoBD Rz. 76). */
  buyerAddress?: string | null;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Kanonische, deterministische Serialisierung der Kerndaten → reproduzierbarer
 * SHA-256. Einzige Quelle für den content_hash, damit Festschreibung und
 * spätere Integritätsprüfung exakt denselben Wert erzeugen. Die Formatversion
 * hält Alt-Belege prüfbar (kein Falsch-Alarm nach Updates).
 */
export function invoiceContentHash(f: InvoiceHashFields): string {
  let canonical =
    `v${f.version}|${f.number}|${f.issueDate}|${f.customerId}|${f.customerName}|` +
    `${f.netTotalCents}|${f.taxTotalCents}|${f.grossTotalCents}|ku=${f.isKleinunternehmer ? 1 : 0}`;
  if (f.version >= 2) canonical += `|order=${f.orderNumber ?? ""}`;
  if (f.version >= 3) canonical += `|cancels=${f.cancelsNumber ?? ""}`;
  if (f.version >= 4) canonical += `|addr=${f.buyerAddress ?? ""}`;
  return sha256Hex(canonical);
}

/** Einzeilige, deterministische Rechnungsanschrift für Snapshot und Hash. */
export function formatBuyerAddress(c: {
  address_line1?: string | null;
  address_line2?: string | null;
  zip?: string | null;
  city?: string | null;
  country_iso?: string | null;
}): string | null {
  const zipCity = [c.zip, c.city].filter(Boolean).join(" ");
  const parts = [c.address_line1, c.address_line2, zipCity, c.country_iso].filter(
    (p): p is string => Boolean(p && p.trim()),
  );
  return parts.length > 0 ? parts.join(", ") : null;
}

function nextInvoiceNumber(db: Database.Database, year: string): string {
  db.prepare(
    `INSERT INTO number_sequences (scope, period, next_value) VALUES ('invoice', ?, 1)
       ON CONFLICT(scope, period) DO UPDATE SET next_value = next_value + 1`,
  ).run(year);
  const row = db
    .prepare(
      "SELECT next_value AS n FROM number_sequences WHERE scope='invoice' AND period = ?",
    )
    .get(year) as { n: number };
  return `${year}-${String(row.n).padStart(4, "0")}`;
}

/**
 * Schreibt eine Rechnung fest (draft -> issued). Alles in einer Transaktion:
 * Nummernvergabe, Betragsberechnung, Hash und Audit-Eintrag – atomar.
 */
export function issueInvoice(db: Database.Database, invoiceId: number): IssueResult {
  const run = db.transaction((id: number): IssueResult => {
    const inv = db
      .prepare(
        "SELECT status, customer_id, service_date, issue_date, order_id, cancels_invoice_id FROM invoices WHERE id = ?",
      )
      .get(id) as
      | {
          status: string;
          customer_id: number;
          service_date: string | null;
          issue_date: string | null;
          order_id: number | null;
          cancels_invoice_id: number | null;
        }
      | undefined;

    if (!inv) throw new GobdError(`Rechnung ${id} nicht gefunden`);
    if (inv.status !== "draft")
      throw new GobdError(`Rechnung ${id} ist bereits festgeschrieben`);
    if (!inv.service_date) throw new GobdError("Leistungsdatum fehlt");

    // Auftragsnummer zum Festschreibe-Zeitpunkt einfrieren (Teil des Belegs).
    const orderNumber =
      inv.order_id != null
        ? (
            db.prepare("SELECT order_number AS n FROM orders WHERE id = ?").get(inv.order_id) as
              | { n: string }
              | undefined
          )?.n ?? null
        : null;

    // Bei Stornorechnungen: Nummer des stornierten Originals (Rückbeziehbarkeit, Rz. 64).
    const cancelsNumber =
      inv.cancels_invoice_id != null
        ? (
            db
              .prepare("SELECT invoice_number AS n FROM invoices WHERE id = ?")
              .get(inv.cancels_invoice_id) as { n: string | null } | undefined
          )?.n ?? null
        : null;

    // Steuermodus zum Zeitpunkt der Festschreibung einfrieren (Snapshot).
    const isKu =
      (
        db.prepare("SELECT is_kleinunternehmer AS k FROM company_settings WHERE id = 1").get() as {
          k: number;
        }
      ).k === 1;

    const rawLines = db
      .prepare(
        `SELECT position, quantity_milli, unit_price_net_cents, tax_rate_bp
           FROM invoice_items WHERE invoice_id = ? ORDER BY position`,
      )
      .all(id) as Array<{
      position: number;
      quantity_milli: number;
      unit_price_net_cents: number;
      tax_rate_bp: number;
    }>;

    if (rawLines.length === 0) throw new GobdError("keine Positionen");

    const lineInputs: LineInput[] = rawLines.map((r) => ({
      quantityMilli: r.quantity_milli,
      unitPriceNetCents: r.unit_price_net_cents,
      taxRateBp: r.tax_rate_bp,
    }));
    const totals = computeInvoiceTotals(lineInputs, isKu);

    const issueDate = inv.issue_date ?? new Date().toISOString().slice(0, 10);
    const year = issueDate.slice(0, 4);
    const number = nextInvoiceNumber(db, year);

    const customer = db
      .prepare(
        `SELECT COALESCE(company_name, contact_last_name, '') AS n,
                address_line1, address_line2, zip, city, country_iso
           FROM customers WHERE id = ?`,
      )
      .get(inv.customer_id) as {
      n: string;
      address_line1: string | null;
      address_line2: string | null;
      zip: string | null;
      city: string | null;
      country_iso: string | null;
    };
    const customerName = customer.n;
    // Anschrift zum Festschreibe-Zeitpunkt einfrieren (Rz. 76: Mehrstück bleibt
    // auch bei späteren Stammdaten-Änderungen aus den Tabellendaten reproduzierbar).
    const buyerAddress = formatBuyerAddress(customer);

    const contentHash = invoiceContentHash({
      version: INVOICE_HASH_VERSION,
      number,
      issueDate,
      customerId: inv.customer_id,
      customerName,
      netTotalCents: totals.netTotalCents,
      taxTotalCents: totals.taxTotalCents,
      grossTotalCents: totals.grossTotalCents,
      isKleinunternehmer: isKu,
      orderNumber,
      cancelsNumber,
      buyerAddress,
    });
    const now = new Date().toISOString();
    assertClockMonotonic(db, now);

    // Positionen einfrieren, solange die Rechnung noch 'draft' ist
    // (der Sperr-Trigger auf invoice_items greift erst bei Status 'issued').
    const freeze = db.prepare(
      `UPDATE invoice_items SET line_net_cents = ?, line_tax_cents = ?, line_gross_cents = ?
         WHERE invoice_id = ? AND position = ?`,
    );
    rawLines.forEach((r, i) => {
      const lr = totals.lines[i];
      const tax = roundDiv(lr.netCents * lr.effectiveTaxRateBp, 10_000);
      freeze.run(lr.netCents, tax, lr.netCents + tax, id, r.position);
    });

    // Rechnung festschreiben.
    db.prepare(
      `UPDATE invoices SET
         status = 'issued', invoice_number = ?, issue_date = ?, is_kleinunternehmer_snapshot = ?,
         net_total_cents = ?, tax_total_cents = ?, gross_total_cents = ?, content_hash = ?,
         buyer_name_snapshot = ?, buyer_address_snapshot = ?, order_number_snapshot = ?,
         hash_version = ?, issued_at = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      number,
      issueDate,
      isKu ? 1 : 0,
      totals.netTotalCents,
      totals.taxTotalCents,
      totals.grossTotalCents,
      contentHash,
      customerName,
      buyerAddress,
      orderNumber,
      INVOICE_HASH_VERSION,
      now,
      now,
      id,
    );

    // Audit-Eintrag als Glied der Hash-Kette anhängen.
    const prev =
      (
        db.prepare("SELECT record_hash AS h FROM audit_log ORDER BY id DESC LIMIT 1").get() as
          | { h: string }
          | undefined
      )?.h ?? "";
    const payload = JSON.stringify({
      entity: "invoice",
      id,
      action: "ISSUE",
      number,
      content_hash: contentHash,
      at: now,
      ...(cancelsNumber ? { cancels: cancelsNumber } : {}),
    });
    const recordHash = sha256Hex(`${prev}|${payload}`);
    const info = db
      .prepare(
        `INSERT INTO audit_log (created_at, entity_type, entity_id, action, payload_json, prev_hash, record_hash)
           VALUES (?, 'invoice', ?, 'ISSUE', ?, ?, ?)`,
      )
      .run(now, id, payload, prev, recordHash);

    return { invoiceId: id, invoiceNumber: number, contentHash, auditId: info.lastInsertRowid };
  });

  return run(invoiceId);
}

export interface CancelResult {
  originalId: number;
  originalNumber: string;
  stornoId: number;
  stornoNumber: string;
  contentHash: string;
}

/**
 * Storniert eine festgeschriebene Rechnung GoBD-konform (Rz. 64, 93): Das
 * Original bleibt unverändert erhalten und wird nur auf 'cancelled' gesetzt;
 * die Korrektur erfolgt als eigene, festgeschriebene **Stornorechnung** mit
 * negierten Mengen und Referenz auf das Original (rückbeziehbar in DB, Journal
 * und E-Rechnung/BT-25). Alles in einer Transaktion.
 */
export function cancelInvoice(
  db: Database.Database,
  invoiceId: number,
  reason: string | null = null,
): CancelResult {
  const run = db.transaction((id: number): CancelResult => {
    const orig = db
      .prepare(
        `SELECT status, invoice_number, customer_id, service_date, notes,
                order_id, cancelled_by_invoice_id, cancels_invoice_id
           FROM invoices WHERE id = ?`,
      )
      .get(id) as
      | {
          status: string;
          invoice_number: string | null;
          customer_id: number;
          service_date: string | null;
          notes: string | null;
          order_id: number | null;
          cancelled_by_invoice_id: number | null;
          cancels_invoice_id: number | null;
        }
      | undefined;

    if (!orig) throw new GobdError(`Rechnung ${id} nicht gefunden`);
    if (orig.status !== "issued")
      throw new GobdError("Nur festgeschriebene Rechnungen können storniert werden.");
    if (orig.cancelled_by_invoice_id != null)
      throw new GobdError("Diese Rechnung ist bereits storniert.");
    if (orig.cancels_invoice_id != null)
      throw new GobdError("Eine Stornorechnung kann nicht storniert werden.");

    const originalNumber = orig.invoice_number ?? `#${id}`;
    const today = new Date().toISOString().slice(0, 10);
    const notes =
      `Storno zu Rechnung ${originalNumber}.` + (reason ? ` Grund: ${reason}` : "");

    // Stornorechnung als eigener Beleg: identische Positionen mit negierter Menge.
    const stornoId = Number(
      db
        .prepare(
          `INSERT INTO invoices (customer_id, status, issue_date, service_date, notes, order_id, cancels_invoice_id)
             VALUES (?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(orig.customer_id, today, orig.service_date, notes, orig.order_id, id).lastInsertRowid,
    );
    db.prepare(
      `INSERT INTO invoice_items (invoice_id, position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp)
         SELECT ?, position, description, -quantity_milli, unit, unit_price_net_cents, tax_rate_bp
           FROM invoice_items WHERE invoice_id = ? ORDER BY position`,
    ).run(stornoId, id);

    const issued = issueInvoice(db, stornoId);

    // Original als storniert kennzeichnen – der Sperr-Trigger erlaubt exakt
    // diesen Übergang (nur status/cancelled_by_invoice_id/updated_at).
    db.prepare(
      "UPDATE invoices SET status = 'cancelled', cancelled_by_invoice_id = ?, updated_at = ? WHERE id = ?",
    ).run(stornoId, new Date().toISOString(), id);

    appendAudit(db, "invoice", id, "CANCEL", {
      number: originalNumber,
      storno_id: stornoId,
      storno_number: issued.invoiceNumber,
      ...(reason ? { reason } : {}),
    });

    return {
      originalId: id,
      originalNumber,
      stornoId,
      stornoNumber: issued.invoiceNumber,
      contentHash: issued.contentHash,
    };
  });

  return run(invoiceId);
}

/**
 * Prüft die Unversehrtheit der Audit-Kette und liefert Kennzahlen: Anzahl der
 * Einträge, Zeitspanne und – falls gebrochen – die id des ersten defekten Glieds.
 */
/** Toleranz für Uhr-Rücksprünge (NTP-Korrekturen), bevor sie als Befund gelten. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

export function verifyAuditChainDetailed(db: Database.Database): GobdReport["auditChain"] {
  const rows = db
    .prepare(
      "SELECT id, created_at, payload_json, prev_hash, record_hash FROM audit_log ORDER BY id ASC",
    )
    .all() as Array<{
    id: number;
    created_at: string;
    payload_json: string;
    prev_hash: string;
    record_hash: string;
  }>;

  let expectedPrev = "";
  let brokenAtId: number | null = null;
  let nonMonotonic = 0;
  let prevTime = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (
      brokenAtId === null &&
      (row.prev_hash !== expectedPrev ||
        sha256Hex(`${expectedPrev}|${row.payload_json}`) !== row.record_hash)
    ) {
      brokenAtId = row.id;
    }
    expectedPrev = row.record_hash;
    // Zeitgerechtheit/Uhr-Manipulation: Journalzeit muss (mit Toleranz) monoton steigen.
    const t = new Date(row.created_at).getTime();
    if (!Number.isNaN(t)) {
      if (t < prevTime - CLOCK_TOLERANCE_MS) nonMonotonic += 1;
      if (t > prevTime) prevTime = t;
    }
  }

  return {
    ok: brokenAtId === null,
    entries: rows.length,
    brokenAtId,
    firstAt: rows[0]?.created_at ?? null,
    lastAt: rows[rows.length - 1]?.created_at ?? null,
    nonMonotonic,
  };
}

/**
 * Prüft die Unversehrtheit der Audit-Kette. Gibt die id des ersten gebrochenen
 * Glieds zurück (null = Kette intakt).
 */
export function verifyAuditChain(db: Database.Database): number | null {
  return verifyAuditChainDetailed(db).brokenAtId;
}

/** Die von der Festschreibung erwarteten GoBD-Sperr-Trigger (Schreibschutz). */
const GOBD_TRIGGERS = [
  "trg_invoices_block_update",
  "trg_invoices_block_update_cancelled",
  "trg_invoices_block_delete",
  "trg_invoice_items_block_update",
  "trg_invoice_items_block_delete",
  "trg_audit_block_update",
  "trg_audit_block_delete",
] as const;

/** Rechnet den content_hash jeder festgeschriebenen Rechnung aus den aktuellen
 * Daten neu und vergleicht ihn mit dem gespeicherten Wert (erkennt nachträgliche
 * Datenmanipulation der eingefrorenen Rechnung, auch am Trigger vorbei). */
function verifyInvoiceHashes(db: Database.Database): GobdReport["invoices"] {
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_number, i.issue_date, i.customer_id,
              i.net_total_cents, i.tax_total_cents, i.gross_total_cents,
              i.is_kleinunternehmer_snapshot AS ku, i.content_hash,
              i.hash_version AS hv, i.order_number_snapshot AS order_no,
              i.buyer_address_snapshot AS buyer_addr,
              o.invoice_number AS cancels_no,
              COALESCE(i.buyer_name_snapshot, c.company_name, c.contact_last_name, '') AS customer_name
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         LEFT JOIN invoices o ON o.id = i.cancels_invoice_id
        WHERE i.status IN ('issued', 'cancelled')
        ORDER BY i.id`,
    )
    .all() as Array<{
    id: number;
    invoice_number: string | null;
    issue_date: string | null;
    customer_id: number;
    net_total_cents: number | null;
    tax_total_cents: number | null;
    gross_total_cents: number | null;
    ku: number | null;
    content_hash: string | null;
    hv: number | null;
    order_no: string | null;
    buyer_addr: string | null;
    cancels_no: string | null;
    customer_name: string;
  }>;

  const tampered: GobdReport["invoices"]["tampered"] = [];
  let hashOk = 0;
  for (const r of rows) {
    const recomputed = invoiceContentHash({
      version: r.hv ?? 1,
      number: r.invoice_number ?? "",
      issueDate: r.issue_date ?? "",
      customerId: r.customer_id,
      customerName: r.customer_name,
      netTotalCents: r.net_total_cents ?? 0,
      taxTotalCents: r.tax_total_cents ?? 0,
      grossTotalCents: r.gross_total_cents ?? 0,
      isKleinunternehmer: r.ku === 1,
      orderNumber: r.order_no,
      cancelsNumber: r.cancels_no,
      buyerAddress: r.buyer_addr,
    });
    if (recomputed === r.content_hash) hashOk += 1;
    else tampered.push({ id: r.id, invoiceNumber: r.invoice_number ?? `#${r.id}` });
  }
  return { issued: rows.length, hashOk, tampered };
}

/** Liest die im (manipulationssicheren) Journal verankerten Soll-Prüfsummen der
 * Rechnungsdateien. Sie sind der bevorzugte Vergleichswert – ihre Änderung würde
 * die Hash-Kette brechen und damit auffallen. */
function anchoredArtifactHashes(db: Database.Database): Map<number, { pdf?: string; xml?: string }> {
  const rows = db
    .prepare(
      "SELECT entity_id, payload_json FROM audit_log WHERE entity_type = 'invoice' AND action = 'ARTIFACTS' ORDER BY id",
    )
    .all() as Array<{ entity_id: number; payload_json: string }>;
  const map = new Map<number, { pdf?: string; xml?: string }>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json) as { pdf_sha256?: string; xml_sha256?: string };
      const entry = map.get(r.entity_id) ?? {};
      if (p.pdf_sha256) entry.pdf = p.pdf_sha256;
      if (p.xml_sha256) entry.xml = p.xml_sha256;
      map.set(r.entity_id, entry);
    } catch {
      /* defekter Payload wird über die Ketten-Prüfung erkannt */
    }
  }
  return map;
}

/** Prüft die Rechnungsdateien byte-genau: Datei vorhanden + SHA-256 stimmt mit dem
 * gespeicherten Soll überein. Trennt Datenverlust (Datei weg) und Manipulation
 * (Hash abweichend) von „noch kein PDF erzeugt". `hashFile` liefert den Hex-SHA-256
 * bzw. null, wenn die Datei fehlt (Kernlogik bleibt dateisystemfrei/testbar). */
function verifyArtifacts(
  db: Database.Database,
  hashFile: (path: string) => string | null,
): GobdReport["artifacts"] {
  const issued = db
    .prepare(
      "SELECT id, invoice_number FROM invoices WHERE status IN ('issued', 'cancelled') ORDER BY id",
    )
    .all() as Array<{ id: number; invoice_number: string | null }>;
  const artRows = db
    .prepare("SELECT invoice_id, kind, path, sha256 FROM invoice_artifacts")
    .all() as Array<{ invoice_id: number; kind: "pdf" | "xml"; path: string; sha256: string | null }>;
  const anchored = anchoredArtifactHashes(db);

  const byInvoice = new Map<number, Partial<Record<"pdf" | "xml", { path: string; sha256: string | null }>>>();
  for (const a of artRows) {
    const entry = byInvoice.get(a.invoice_id) ?? {};
    entry[a.kind] = { path: a.path, sha256: a.sha256 };
    byInvoice.set(a.invoice_id, entry);
  }

  const missingFiles: GobdReport["artifacts"]["missingFiles"] = [];
  const hashMismatch: GobdReport["artifacts"]["hashMismatch"] = [];
  const withoutPdf: GobdReport["artifacts"]["withoutPdf"] = [];
  let pdfOk = 0;
  let hashChecked = 0;

  const checkFile = (
    num: string,
    kind: "pdf" | "xml",
    art: { path: string; sha256: string | null },
    expectedAnchored: string | undefined,
  ): "ok" | "missing" | "mismatch" => {
    const actual = hashFile(art.path);
    if (actual === null) {
      missingFiles.push({ invoiceNumber: num, kind, path: art.path });
      return "missing";
    }
    const expected = expectedAnchored ?? art.sha256;
    if (expected && actual !== expected) {
      hashMismatch.push({ invoiceNumber: num, kind, path: art.path });
      return "mismatch";
    }
    if (expected) hashChecked += 1;
    return "ok";
  };

  for (const inv of issued) {
    const num = inv.invoice_number ?? `#${inv.id}`;
    const entry = byInvoice.get(inv.id) ?? {};
    const anc = anchored.get(inv.id) ?? {};
    if (!entry.pdf) withoutPdf.push({ invoiceNumber: num });
    else if (checkFile(num, "pdf", entry.pdf, anc.pdf) === "ok") pdfOk += 1;
    if (entry.xml) checkFile(num, "xml", entry.xml, anc.xml);
  }
  return { expectedPdf: issued.length, pdfOk, hashChecked, missingFiles, hashMismatch, withoutPdf };
}

/** Rekonstruiert den Soll-Zustand von Zahlungen und Ausgaben aus den Journal-
 * Snapshots (manipulationssicher über die Hash-Kette) und vergleicht ihn mit den
 * Tabellen. Erkennt Einfügen/Ändern/Löschen an der App vorbei (GoBD Rz. 88). */
function verifySideRecords(db: Database.Database): GobdReport["sideRecords"] {
  const journal = db
    .prepare(
      "SELECT entity_type, entity_id, action, payload_json FROM audit_log WHERE entity_type IN ('payment','expense') ORDER BY id",
    )
    .all() as Array<{ entity_type: string; entity_id: number; action: string; payload_json: string }>;

  const expectedPayments = new Map<number, Record<string, unknown>>();
  const expectedExpenses = new Map<number, Record<string, unknown>>();
  for (const row of journal) {
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue; // defekter Payload fällt bereits in der Ketten-Prüfung auf
    }
    if (row.entity_type === "payment") {
      if (row.action === "ADD") expectedPayments.set(row.entity_id, p);
      else if (row.action === "DELETE") expectedPayments.delete(row.entity_id);
    } else if (row.entity_type === "expense") {
      if (row.action === "CREATE" || row.action === "UPDATE") expectedExpenses.set(row.entity_id, p);
    }
  }

  const mismatches: GobdReport["sideRecords"]["mismatches"] = [];

  const payments = db
    .prepare("SELECT id, invoice_id, paid_at, amount_cents FROM payments ORDER BY id")
    .all() as Array<{ id: number; invoice_id: number; paid_at: string; amount_cents: number }>;
  let paymentsOk = 0;
  for (const p of payments) {
    const exp = expectedPayments.get(p.id);
    if (!exp) {
      mismatches.push({ kind: "payment", id: p.id, problem: "nicht im Journal erfasst" });
    } else if (
      exp.invoice_id !== p.invoice_id ||
      exp.paid_at !== p.paid_at ||
      exp.amount_cents !== p.amount_cents
    ) {
      mismatches.push({ kind: "payment", id: p.id, problem: "weicht vom Journal-Snapshot ab" });
    } else {
      paymentsOk += 1;
    }
    expectedPayments.delete(p.id);
  }
  for (const id of expectedPayments.keys()) {
    mismatches.push({ kind: "payment", id, problem: "laut Journal vorhanden, aber gelöscht" });
  }

  const EXPENSE_FIELDS = [
    "expense_date",
    "payment_date",
    "description",
    "vendor",
    "category_id",
    "net_cents",
    "tax_cents",
    "gross_cents",
    "tax_rate_bp",
    "deductible_permille",
    "order_id",
  ] as const;
  const expenses = db
    .prepare(`SELECT id, ${EXPENSE_FIELDS.join(", ")} FROM expenses ORDER BY id`)
    .all() as Array<Record<string, unknown> & { id: number }>;
  let expensesOk = 0;
  for (const e of expenses) {
    const exp = expectedExpenses.get(e.id);
    if (!exp) {
      mismatches.push({ kind: "expense", id: e.id, problem: "nicht im Journal erfasst" });
    } else if (EXPENSE_FIELDS.some((f) => (exp[f] ?? null) !== (e[f] ?? null))) {
      mismatches.push({ kind: "expense", id: e.id, problem: "weicht vom Journal-Snapshot ab" });
    } else {
      expensesOk += 1;
    }
    expectedExpenses.delete(e.id);
  }
  for (const id of expectedExpenses.keys()) {
    mismatches.push({ kind: "expense", id, problem: "laut Journal vorhanden, aber gelöscht" });
  }

  return {
    payments: payments.length,
    paymentsOk,
    expenses: expenses.length,
    expensesOk,
    mismatches,
  };
}

/** Prüft alle DMS-Dokumente byte-genau gegen die beim Import gespeicherte
 * SHA-256-Prüfsumme (GoBD Rz. 110: Dateisystem-Ablage braucht Zusatzmaßnahmen). */
function verifyDocuments(
  db: Database.Database,
  hashFile: (path: string) => string | null,
): GobdReport["documents"] {
  const rows = db
    .prepare("SELECT id, title, stored_path, content_sha256 FROM documents ORDER BY id")
    .all() as Array<{ id: number; title: string; stored_path: string; content_sha256: string }>;
  const missing: GobdReport["documents"]["missing"] = [];
  const mismatch: GobdReport["documents"]["mismatch"] = [];
  let ok = 0;
  for (const r of rows) {
    const actual = hashFile(r.stored_path);
    if (actual === null) missing.push({ id: r.id, title: r.title });
    else if (actual !== r.content_sha256) mismatch.push({ id: r.id, title: r.title });
    else ok += 1;
  }
  return { total: rows.length, ok, missing, mismatch };
}

/** Zeitgerechtheit (Rz. 45 ff.): alte, nicht festgeschriebene Entwürfe als Hinweis. */
const STALE_DRAFT_DAYS = 30;

function verifyTimeliness(db: Database.Database): GobdReport["timeliness"] {
  const drafts = db
    .prepare("SELECT created_at FROM invoices WHERE status = 'draft'")
    .all() as Array<{ created_at: string }>;
  const now = Date.now();
  let staleDrafts = 0;
  let oldestDraftDays: number | null = null;
  for (const d of drafts) {
    const ageDays = Math.floor((now - new Date(d.created_at).getTime()) / 86_400_000);
    if (Number.isNaN(ageDays)) continue;
    if (ageDays > STALE_DRAFT_DAYS) staleDrafts += 1;
    if (oldestDraftDays === null || ageDays > oldestDraftDays) oldestDraftDays = ageDays;
  }
  return { openDrafts: drafts.length, staleDrafts, oldestDraftDays };
}

/** Prüft, ob die GoBD-Sperr-Trigger (Schreibschutz) noch im Schema vorhanden sind. */
function verifyGobdTriggers(db: Database.Database): GobdReport["triggers"] {
  const placeholders = GOBD_TRIGGERS.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${placeholders})`)
    .all(...GOBD_TRIGGERS) as Array<{ name: string }>;
  const present = new Set(rows.map((r) => r.name));
  const missing = GOBD_TRIGGERS.filter((n) => !present.has(n));
  return { ok: missing.length === 0, present: present.size, expected: GOBD_TRIGGERS.length, missing };
}

/**
 * Schneller Integritäts-Check für den App-Start (nur DB, keine Datei-Hashes):
 * Journal-Hash-Kette, Beleg-Prüfsummen und Zeitstempel-Monotonie.
 */
export function quickCheckGobd(db: Database.Database): GobdQuickCheck {
  const chain = verifyAuditChainDetailed(db);
  const invoices = verifyInvoiceHashes(db);
  return {
    ok: chain.ok && invoices.tampered.length === 0,
    chainOk: chain.ok,
    brokenAtId: chain.brokenAtId,
    nonMonotonic: chain.nonMonotonic,
    tampered: invoices.tampered.length,
  };
}

/**
 * Vollständige GoBD-Selbstprüfung: Journal-Hash-Kette, Neuberechnung der
 * Beleg-Prüfsummen, byte-genaue Prüfung der Rechnungsdateien und Schreibschutz-
 * Trigger. `hashFile` (Datei → Hex-SHA-256 bzw. null) wird injiziert, damit die
 * Kernlogik dateisystemfrei und testbar bleibt.
 */
export function verifyGobd(
  db: Database.Database,
  hashFile: (path: string) => string | null,
): GobdReport {
  const auditChain = verifyAuditChainDetailed(db);
  const invoices = verifyInvoiceHashes(db);
  const artifacts = verifyArtifacts(db, hashFile);
  const triggers = verifyGobdTriggers(db);
  const sideRecords = verifySideRecords(db);
  const documents = verifyDocuments(db, hashFile);
  const timeliness = verifyTimeliness(db); // Hinweis, fließt nicht ins Gesamt-ok ein
  const ok =
    auditChain.ok &&
    invoices.tampered.length === 0 &&
    artifacts.missingFiles.length === 0 &&
    artifacts.hashMismatch.length === 0 &&
    triggers.ok &&
    sideRecords.mismatches.length === 0 &&
    documents.missing.length === 0 &&
    documents.mismatch.length === 0;
  return {
    ok,
    checkedAt: new Date().toISOString(),
    auditChain,
    invoices,
    artifacts,
    triggers,
    sideRecords,
    documents,
    timeliness,
  };
}

/** Blockiert Journaleinträge, wenn die Systemuhr deutlich vor dem letzten
 * Eintrag steht (Manipulationsschutz gegen zurückgestellte Systemzeit). */
function assertClockMonotonic(db: Database.Database, nowIso: string): void {
  const last = (
    db.prepare("SELECT created_at AS t FROM audit_log ORDER BY id DESC LIMIT 1").get() as
      | { t: string }
      | undefined
  )?.t;
  if (!last) return;
  const now = new Date(nowIso).getTime();
  const prev = new Date(last).getTime();
  if (!Number.isNaN(now) && !Number.isNaN(prev) && now < prev - CLOCK_TOLERANCE_MS) {
    throw new GobdError(
      `Die Systemuhr (${nowIso}) liegt vor dem letzten Journaleintrag (${last}). ` +
        "Bitte Datum/Uhrzeit des Rechners prüfen – der Vorgang wurde nicht gespeichert.",
    );
  }
}

/**
 * Hängt einen beliebigen Vorgang an die Audit-Kette an (append-only) – z. B. eine
 * Ausgaben-Korrektur. Macht Änderungen GoBD-konform nachvollziehbar.
 */
export function appendAudit(
  db: Database.Database,
  entityType: string,
  entityId: number,
  action: string,
  payload: Record<string, unknown> = {},
): void {
  const prev =
    (
      db.prepare("SELECT record_hash AS h FROM audit_log ORDER BY id DESC LIMIT 1").get() as
        | { h: string }
        | undefined
    )?.h ?? "";
  const now = new Date().toISOString();
  assertClockMonotonic(db, now);
  const payloadJson = JSON.stringify({ entity: entityType, id: entityId, action, at: now, ...payload });
  const recordHash = sha256Hex(`${prev}|${payloadJson}`);
  db.prepare(
    `INSERT INTO audit_log (created_at, entity_type, entity_id, action, payload_json, prev_hash, record_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(now, entityType, entityId, action, payloadJson, prev, recordHash);
}

function centsToEur(cents: number): string {
  return `${(cents / 100).toFixed(2).replace(".", ",")} €`;
}

/** Übersetzt einen Journal-Payload in Beleg-Referenz + Klartext + Bezug zur Rechnung. */
function describeAudit(
  entityType: string,
  entityId: number,
  action: string,
  payload: Record<string, unknown>,
  invoiceNumbers: Map<number, string>,
): { reference: string | null; summary: string; relatedInvoiceId: number | null } {
  const invNo = (id: unknown): string | null =>
    typeof id === "number" ? (invoiceNumbers.get(id) ?? `#${id}`) : null;
  const amount = (v: unknown): string => (typeof v === "number" ? centsToEur(v) : "");

  if (entityType === "invoice") {
    const relatedInvoiceId = entityId;
    if (action === "ISSUE")
      return {
        reference: (payload.number as string) ?? invNo(entityId),
        summary:
          typeof payload.cancels === "string"
            ? `Stornorechnung festgeschrieben (Storno zu ${payload.cancels})`
            : "Rechnung festgeschrieben",
        relatedInvoiceId,
      };
    if (action === "ARTIFACTS")
      return {
        reference: invNo(entityId),
        summary: "E-Rechnung erzeugt (PDF/XML, Prüfsummen verankert)",
        relatedInvoiceId,
      };
    if (action === "CANCEL")
      return {
        reference: (payload.number as string) ?? invNo(entityId),
        summary:
          `Rechnung storniert durch ${(payload.storno_number as string) ?? "Stornobeleg"}` +
          (typeof payload.reason === "string" ? ` – Grund: ${payload.reason}` : ""),
        relatedInvoiceId,
      };
    return { reference: invNo(entityId), summary: `Rechnung · ${action}`, relatedInvoiceId };
  }
  if (entityType === "payment") {
    const relatedInvoiceId = typeof payload.invoice_id === "number" ? payload.invoice_id : null;
    const ref = invNo(payload.invoice_id);
    if (action === "ADD")
      return { reference: ref, summary: `Zahlung erfasst: ${amount(payload.amount_cents)}`, relatedInvoiceId };
    if (action === "DELETE")
      return { reference: ref, summary: `Zahlung storniert: ${amount(payload.amount_cents)}`, relatedInvoiceId };
    return { reference: ref, summary: `Zahlung · ${action}`, relatedInvoiceId };
  }
  if (entityType === "expense") {
    const desc = typeof payload.description === "string" ? payload.description : null;
    if (action === "CREATE")
      return { reference: desc, summary: `Ausgabe erfasst: ${amount(payload.gross_cents)}`, relatedInvoiceId: null };
    if (action === "UPDATE")
      return { reference: desc, summary: `Ausgabe korrigiert: ${amount(payload.gross_cents)}`, relatedInvoiceId: null };
    return { reference: desc, summary: `Ausgabe · ${action}`, relatedInvoiceId: null };
  }
  if (entityType === "backup") {
    return {
      reference: typeof payload.path === "string" ? payload.path : null,
      summary: "Datensicherung erstellt (Prüfsumme im Journal verankert)",
      relatedInvoiceId: null,
    };
  }
  if (entityType === "verfdok") {
    const format = typeof payload.format === "string" ? payload.format.toUpperCase() : "";
    return {
      reference: typeof payload.file === "string" ? payload.file : null,
      summary: `Verfahrensdokumentation exportiert${format ? ` (${format})` : ""} – Fassung im Journal verankert`,
      relatedInvoiceId: null,
    };
  }
  if (entityType === "document") {
    const title = typeof payload.title === "string" ? payload.title : null;
    const summaries: Record<string, string> = {
      IMPORT: "Dokument aufgenommen (Eingang protokolliert, Prüfsumme gespeichert)",
      UPDATE: "Dokument-Metadaten geändert",
      OCR: "OCR-Text korrigiert",
      ARCHIVE: "Dokument archiviert",
      RESTORE: "Dokument aus dem Archiv geholt",
      DELETE: "Dokument gelöscht (war unverknüpft)",
    };
    return {
      reference: title,
      summary: summaries[action] ?? `Dokument · ${action}`,
      relatedInvoiceId: null,
    };
  }
  return { reference: null, summary: `${entityType} · ${action}`, relatedInvoiceId: null };
}

/**
 * Liefert das Journal (audit_log) als menschenlesbaren, chronologischen Nachweis.
 * Pro Eintrag wird die Verkettung an dieser Stelle mitgeprüft (`chainOk`), sodass
 * die lückenlose Nachverfolgung direkt sichtbar ist.
 */
export function listJournal(db: Database.Database): JournalEntry[] {
  const rows = db
    .prepare(
      "SELECT id, created_at, entity_type, entity_id, action, payload_json, prev_hash, record_hash FROM audit_log ORDER BY id ASC",
    )
    .all() as Array<{
    id: number;
    created_at: string;
    entity_type: string;
    entity_id: number;
    action: string;
    payload_json: string;
    prev_hash: string;
    record_hash: string;
  }>;

  const invoiceNumbers = new Map<number, string>();
  for (const r of db
    .prepare("SELECT id, invoice_number FROM invoices WHERE invoice_number IS NOT NULL")
    .all() as Array<{ id: number; invoice_number: string }>) {
    invoiceNumbers.set(r.id, r.invoice_number);
  }

  let expectedPrev = "";
  const out: JournalEntry[] = [];
  for (const row of rows) {
    const chainOk =
      row.prev_hash === expectedPrev &&
      sha256Hex(`${expectedPrev}|${row.payload_json}`) === row.record_hash;
    expectedPrev = row.record_hash;

    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      /* defekter Payload → chainOk ist ohnehin false */
    }
    const { reference, summary, relatedInvoiceId } = describeAudit(
      row.entity_type,
      row.entity_id,
      row.action,
      payload,
      invoiceNumbers,
    );
    out.push({
      id: row.id,
      at: row.created_at,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      reference,
      summary,
      relatedInvoiceId,
      recordHash: row.record_hash,
      chainOk,
    });
  }
  return out;
}

/** Journaleinträge, die eine bestimmte Rechnung betreffen (Beleg-Historie). */
export function listJournalForInvoice(db: Database.Database, invoiceId: number): JournalEntry[] {
  return listJournal(db).filter((e) => e.relatedInvoiceId === invoiceId);
}
