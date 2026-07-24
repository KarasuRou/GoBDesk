/** Datenzugriff für den Main-Prozess (liest/schreibt via better-sqlite3). */

import type Database from "better-sqlite3";

import { issueInvoice } from "../core/gobd.js";
import type {
  CompanySettings,
  CompanySettingsInput,
  Customer,
  CustomerDetail,
  CustomerInput,
  CustomerListItem,
  DemoInvoiceResult,
} from "../shared/api.js";

const today = (): string => new Date().toISOString().slice(0, 10);

const cleanOrNull = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t.length ? t : null;
};

/**
 * Legt beim allerersten Start nur den (leeren) Firmendatensatz an, damit die App
 * lauffähig ist. Bewusst *keine* Beispieldaten – die Firmendaten hinterlegt der
 * Anwender selbst unter Einstellungen.
 */
export function seedDefaults(db: Database.Database): void {
  const hasSettings = db.prepare("SELECT 1 FROM company_settings WHERE id = 1").get();
  if (!hasSettings) {
    db.prepare(
      `INSERT INTO company_settings (id, legal_name, address_line1, zip, city, is_kleinunternehmer)
       VALUES (1, '', '', '', '', 1)`,
    ).run();
  }
}

export function getSettings(db: Database.Database): CompanySettings | null {
  const row = db
    .prepare(
      `SELECT id, legal_name, address_line1, zip, city, country_iso,
              tax_number, vat_id, is_kleinunternehmer, email, iban, bic, paypal
         FROM company_settings WHERE id = 1`,
    )
    .get() as CompanySettings | undefined;
  return row ?? null;
}

/** Aktualisiert die Firmendaten (§14-Pflichtangaben). Firmenname ist Pflicht. */
export function updateSettings(db: Database.Database, input: CompanySettingsInput): void {
  const legalName = input.legal_name.trim();
  if (legalName.length === 0) throw new Error("Bitte einen Firmennamen angeben.");

  db.prepare(
    `UPDATE company_settings SET
       legal_name = @legal_name, address_line1 = @address_line1, zip = @zip, city = @city,
       country_iso = @country_iso, tax_number = @tax_number, vat_id = @vat_id,
       is_kleinunternehmer = @is_kleinunternehmer, email = @email, iban = @iban, bic = @bic,
       paypal = @paypal, updated_at = @updated_at
     WHERE id = 1`,
  ).run({
    legal_name: legalName,
    address_line1: (input.address_line1 ?? "").trim(),
    zip: (input.zip ?? "").trim(),
    city: (input.city ?? "").trim(),
    country_iso: cleanOrNull(input.country_iso) ?? "DE",
    tax_number: cleanOrNull(input.tax_number),
    vat_id: cleanOrNull(input.vat_id),
    is_kleinunternehmer: input.is_kleinunternehmer ? 1 : 0,
    email: cleanOrNull(input.email),
    iban: cleanOrNull(input.iban),
    bic: cleanOrNull(input.bic),
    paypal: cleanOrNull(input.paypal),
    updated_at: new Date().toISOString(),
  });
}

export function listCustomers(db: Database.Database): Customer[] {
  return db
    .prepare(
      "SELECT id, customer_number, company_name, city, is_active FROM customers ORDER BY id",
    )
    .all() as Customer[];
}

/** Kundenliste mit Kennzahlen (Rechnungen, Umsatz, offener Betrag) + optionaler Suche. */
export function listCustomersDetailed(db: Database.Database, search?: string): CustomerListItem[] {
  const q = (search ?? "").trim();
  const stmt = db.prepare(
    `SELECT cu.id, cu.customer_number,
            COALESCE(cu.company_name, cu.contact_last_name, '') AS name,
            cu.city, cu.email, cu.vat_id,
            (SELECT COUNT(*) FROM invoices i WHERE i.customer_id = cu.id AND i.status IN ('issued', 'cancelled')) AS invoice_count,
            (SELECT COALESCE(SUM(i.gross_total_cents), 0) FROM invoices i WHERE i.customer_id = cu.id AND i.status IN ('issued', 'cancelled')) AS gross_total_cents,
            -- Storno-Paare (Original + Gegenbeleg) heben sich auf; offen bleibt nur,
            -- was tatsächlich (noch) nicht gezahlt bzw. rückerstattet wurde.
            (SELECT COALESCE(SUM(i.gross_total_cents), 0) FROM invoices i WHERE i.customer_id = cu.id AND i.status IN ('issued', 'cancelled'))
              - (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p JOIN invoices i ON i.id = p.invoice_id
                   WHERE i.customer_id = cu.id AND i.status IN ('issued', 'cancelled')) AS open_cents
       FROM customers cu
      WHERE (@q = '' OR cu.company_name LIKE @like OR cu.contact_last_name LIKE @like
             OR cu.city LIKE @like OR cu.email LIKE @like OR cu.vat_id LIKE @like
             OR cu.customer_number LIKE @like)
      ORDER BY cu.id`,
  );
  return stmt.all({ q, like: `%${q}%` }) as CustomerListItem[];
}

type NormalizedCustomer = Omit<CustomerInput, "kind"> & { kind: "company" | "individual" };

/** Trimmt Felder, setzt Defaults und erzwingt die §14-Mindestangabe (ein Name). */
function normalizeCustomer(input: CustomerInput): NormalizedCustomer {
  const clean = (v: string | null | undefined): string | null => {
    const t = (v ?? "").trim();
    return t.length ? t : null;
  };
  const c: NormalizedCustomer = {
    kind: input.kind === "individual" ? "individual" : "company",
    company_name: clean(input.company_name),
    contact_last_name: clean(input.contact_last_name),
    street: clean(input.street),
    zip: clean(input.zip),
    city: clean(input.city),
    country_iso: clean(input.country_iso) ?? "DE",
    email: clean(input.email),
    vat_id: clean(input.vat_id),
  };
  if (!c.company_name && !c.contact_last_name) {
    throw new Error("Bitte Firmenname oder Nachname angeben.");
  }
  return c;
}

export function getCustomer(db: Database.Database, id: number): CustomerDetail | null {
  const row = db
    .prepare(
      `SELECT id, customer_number, kind, company_name, contact_last_name,
              address_line1 AS street, zip, city, country_iso, email, vat_id, is_active
         FROM customers WHERE id = ?`,
    )
    .get(id) as CustomerDetail | undefined;
  return row ?? null;
}

export function createCustomer(db: Database.Database, input: CustomerInput): number {
  const c = normalizeCustomer(input);
  const info = db
    .prepare(
      `INSERT INTO customers (kind, company_name, contact_last_name, address_line1, zip, city, country_iso, email, vat_id)
       VALUES (@kind, @company_name, @contact_last_name, @street, @zip, @city, @country_iso, @email, @vat_id)`,
    )
    .run(c);
  return Number(info.lastInsertRowid);
}

export function updateCustomer(db: Database.Database, id: number, input: CustomerInput): void {
  const c = normalizeCustomer(input);
  db.prepare(
    `UPDATE customers SET
       kind = @kind, company_name = @company_name, contact_last_name = @contact_last_name,
       address_line1 = @street, zip = @zip, city = @city, country_iso = @country_iso,
       email = @email, vat_id = @vat_id, updated_at = @updated_at
     WHERE id = @id`,
  ).run({ ...c, id, updated_at: new Date().toISOString() });
}

/** Legt eine Beispielrechnung an und schreibt sie fest (nur für Tests/Smoke). */
export function runDemoInvoice(db: Database.Database): DemoInvoiceResult {
  let cust = db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined;
  if (!cust) {
    const id = Number(
      db
        .prepare(
          `INSERT INTO customers (kind, company_name, country_iso, city)
           VALUES ('company', 'Beispielkunde GmbH', 'DE', 'Berlin')`,
        )
        .run().lastInsertRowid,
    );
    cust = { id };
  }

  const invId = Number(
    db
      .prepare(
        "INSERT INTO invoices (customer_id, status, issue_date, service_date) VALUES (?, 'draft', ?, ?)",
      )
      .run(cust.id, today(), today()).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO invoice_items (invoice_id, position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp)
     VALUES (?, 1, 'Beratungsleistung', 8000, 'HUR', 9000, 1900)`,
  ).run(invId);
  db.prepare(
    `INSERT INTO invoice_items (invoice_id, position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp)
     VALUES (?, 2, 'Fachbuch', 2000, 'C62', 2500, 700)`,
  ).run(invId);

  const res = issueInvoice(db, invId);
  const row = db
    .prepare("SELECT net_total_cents, tax_total_cents, gross_total_cents FROM invoices WHERE id = ?")
    .get(invId) as {
    net_total_cents: number;
    tax_total_cents: number;
    gross_total_cents: number;
  };

  return { invoiceNumber: res.invoiceNumber, contentHash: res.contentHash, ...row };
}
