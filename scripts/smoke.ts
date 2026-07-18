/**
 * Smoke-Test des TypeScript-Kerns: legt eine temporäre DB an, wendet das Schema
 * an, schreibt eine Rechnung fest und weist die GoBD-Garantien nach
 * (Sperr-Trigger, Audit-Kette). Ausführen: `npm run smoke`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { openDatabase } from "../src/db/database.js";
import { GobdError, issueInvoice, verifyAuditChain } from "../src/core/gobd.js";
import {
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from "../src/main/repository.js";

const dir = mkdtempSync(path.join(tmpdir(), "gobdesk-"));
const db = openDatabase(path.join(dir, "test.sqlite"));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (cond) pass++;
  else fail++;
}

// --- Seed (Regelbesteuerung) ---
db.prepare(
  `INSERT INTO company_settings (id, legal_name, address_line1, zip, city, is_kleinunternehmer)
     VALUES (1, 'Musterberatung', 'Beispielweg 1', '50667', 'Köln', 0)`,
).run();

const custId = db
  .prepare("INSERT INTO customers (kind, company_name, country_iso) VALUES ('company', 'Kunde GmbH', 'DE')")
  .run().lastInsertRowid as number;

const invId = db
  .prepare(
    "INSERT INTO invoices (customer_id, status, issue_date, service_date) VALUES (?, 'draft', '2026-07-08', '2026-06-30')",
  )
  .run(custId).lastInsertRowid as number;

db.prepare(
  `INSERT INTO invoice_items (invoice_id, position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp)
     VALUES (?, 1, 'Beratung', 8000, 'HUR', 9000, 1900)`,
).run(invId);
db.prepare(
  `INSERT INTO invoice_items (invoice_id, position, description, quantity_milli, unit, unit_price_net_cents, tax_rate_bp)
     VALUES (?, 2, 'Fachbuch', 2000, 'C62', 2500, 700)`,
).run(invId);

// --- Festschreiben ---
const res = issueInvoice(db, invId);
console.log("Festgeschrieben:", res);
check("Rechnungsnummer 2026-0001 vergeben", res.invoiceNumber === "2026-0001");
check("Content-Hash gesetzt (64 hex)", /^[0-9a-f]{64}$/.test(res.contentHash));

const issued = db
  .prepare("SELECT status, net_total_cents, tax_total_cents, gross_total_cents FROM invoices WHERE id = ?")
  .get(invId) as {
  status: string;
  net_total_cents: number;
  tax_total_cents: number;
  gross_total_cents: number;
};
check("Status = issued", issued.status === "issued");
check("Netto 77000", issued.net_total_cents === 77000);
check("USt 14030", issued.tax_total_cents === 14030);
check("Brutto 91030", issued.gross_total_cents === 91030);

// --- GoBD: Sperr-Trigger ---
let updBlocked = false;
try {
  db.prepare("UPDATE invoices SET notes = 'manipuliert' WHERE id = ?").run(invId);
} catch {
  updBlocked = true;
}
check("Trigger blockt UPDATE auf festgeschriebene Rechnung", updBlocked);

let delBlocked = false;
try {
  db.prepare("DELETE FROM invoices WHERE id = ?").run(invId);
} catch {
  delBlocked = true;
}
check("Trigger blockt DELETE auf festgeschriebene Rechnung", delBlocked);

let itemBlocked = false;
try {
  db.prepare("UPDATE invoice_items SET description = 'x' WHERE invoice_id = ?").run(invId);
} catch {
  itemBlocked = true;
}
check("Trigger blockt UPDATE auf Positionen einer issued-Rechnung", itemBlocked);

// --- Audit-Kette ---
check("Audit-Kette intakt", verifyAuditChain(db) === null);

// --- Zweite Festschreibung schlägt fehl ---
let reissueFailed = false;
try {
  issueInvoice(db, invId);
} catch (e) {
  reissueFailed = e instanceof GobdError;
}
check("Zweite Festschreibung wirft GobdError", reissueFailed);

// --- Kunden-CRUD (Phase 4) ---
const before = listCustomers(db).length;
const newCustomerId = createCustomer(db, {
  kind: "company",
  company_name: "Neu GmbH",
  contact_last_name: null,
  street: "Weg 2",
  zip: "20095",
  city: "Hamburg",
  country_iso: "DE",
  email: "kontakt@neu.de",
  vat_id: null,
});
check("createCustomer liefert id", typeof newCustomerId === "number" && newCustomerId > 0);
check("listCustomers zeigt +1", listCustomers(db).length === before + 1);
check("getCustomer liest Kunde", getCustomer(db, newCustomerId)?.company_name === "Neu GmbH");

const detail = getCustomer(db, newCustomerId);
updateCustomer(db, newCustomerId, { ...detail!, company_name: "Neu AG" });
check("updateCustomer ändert Namen", getCustomer(db, newCustomerId)?.company_name === "Neu AG");

let customerValidation = false;
try {
  createCustomer(db, {
    kind: "company",
    company_name: null,
    contact_last_name: null,
    street: null,
    zip: null,
    city: null,
    country_iso: "DE",
    email: null,
    vat_id: null,
  });
} catch {
  customerValidation = true;
}
check("createCustomer ohne Namen wirft Fehler", customerValidation);

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
