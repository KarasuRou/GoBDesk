/**
 * Sonstige Betriebseinnahmen außerhalb einer Rechnung – typischer Fall:
 * **Mahngebühren und Verzugszinsen**.
 *
 * Fachlich: Diese sind Betriebseinnahmen **bei Zufluss** (§ 11 EStG), aber
 * **ohne Umsatzsteuer** – echter Schadensersatz (Verzugsschaden), kein
 * Leistungsaustausch. Sie gehören deshalb weder in die festgeschriebene
 * Rechnung noch in `payments`: dort würden sie mit dem USt-Split der Rechnung
 * verrechnet und der Zahlungsstatus verfälscht.
 *
 * Technisch analog zu `expenses`: korrigierbar, aber jede Anlage/Änderung wird
 * mit vollständigem Snapshot journalisiert und von `verifyGobd` gegen die
 * Tabelle abgeglichen (Nebenaufzeichnung, GoBD Rz. 58/88).
 */

import type Database from "better-sqlite3";

import { appendAudit } from "../core/gobd.js";
import { roundDiv } from "../core/tax.js";
import type {
  EuerCategory,
  OtherIncomeDetail,
  OtherIncomeInput,
  OtherIncomeListItem,
} from "../shared/api.js";

function grossToNet(grossCents: number, rateBp: number): number {
  return roundDiv(grossCents * 10_000, 10_000 + rateBp);
}

/** Einnahme-Kategorien der EÜR (Auswahl im Formular). */
export function listIncomeCategories(db: Database.Database): EuerCategory[] {
  return db
    .prepare(
      "SELECT id, code, name, kind FROM euer_categories WHERE kind = 'income' ORDER BY sort_order",
    )
    .all() as EuerCategory[];
}

/** Fachlicher Zustand für den Journal-Snapshot (ohne updated_at). */
function incomeSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return {
    income_date: row.income_date,
    description: row.description,
    category_id: row.category_id,
    net_cents: row.net_cents,
    tax_cents: row.tax_cents,
    gross_cents: row.gross_cents,
    tax_rate_bp: row.tax_rate_bp,
    invoice_id: row.invoice_id,
    note: row.note,
  };
}

function buildRow(input: OtherIncomeInput): Record<string, unknown> {
  const description = input.description.trim();
  if (description.length === 0) throw new Error("Bitte eine Beschreibung angeben.");
  if (input.gross_cents <= 0) throw new Error("Der Betrag muss größer als 0 sein.");
  const net = grossToNet(input.gross_cents, input.tax_rate_bp);
  return {
    income_date: input.income_date,
    description,
    category_id: input.category_id,
    net_cents: net,
    tax_rate_bp: input.tax_rate_bp,
    tax_cents: input.gross_cents - net,
    gross_cents: input.gross_cents,
    invoice_id: input.invoice_id ?? null,
    note: input.note?.trim() || null,
  };
}

export function createOtherIncome(db: Database.Database, input: OtherIncomeInput): number {
  const row = buildRow(input);
  const run = db.transaction((): number => {
    const info = db
      .prepare(
        `INSERT INTO other_income
           (income_date, description, category_id, net_cents, tax_rate_bp, tax_cents,
            gross_cents, invoice_id, note)
         VALUES (@income_date, @description, @category_id, @net_cents, @tax_rate_bp, @tax_cents,
            @gross_cents, @invoice_id, @note)`,
      )
      .run(row);
    const id = Number(info.lastInsertRowid);
    appendAudit(db, "income", id, "CREATE", incomeSnapshot(row));
    return id;
  });
  return run();
}

export function getOtherIncome(db: Database.Database, id: number): OtherIncomeDetail | null {
  const row = db
    .prepare(
      `SELECT id, income_date, description, category_id, gross_cents, tax_rate_bp, invoice_id, note
         FROM other_income WHERE id = ?`,
    )
    .get(id) as OtherIncomeDetail | undefined;
  return row ?? null;
}

/** Ändert eine Einnahme und protokolliert die Korrektur in der Audit-Kette. */
export function updateOtherIncome(
  db: Database.Database,
  id: number,
  input: OtherIncomeInput,
): void {
  const row = { ...buildRow(input), id, updated_at: new Date().toISOString() };
  const run = db.transaction(() => {
    const before = db
      .prepare(
        `SELECT income_date, description, category_id, net_cents, tax_cents, gross_cents,
                tax_rate_bp, invoice_id, note FROM other_income WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!before) throw new Error("Einnahme nicht gefunden.");
    db.prepare(
      `UPDATE other_income SET
         income_date = @income_date, description = @description, category_id = @category_id,
         net_cents = @net_cents, tax_rate_bp = @tax_rate_bp, tax_cents = @tax_cents,
         gross_cents = @gross_cents, invoice_id = @invoice_id, note = @note,
         updated_at = @updated_at
       WHERE id = @id`,
    ).run(row);
    appendAudit(db, "income", id, "UPDATE", { ...incomeSnapshot(row), before });
  });
  run();
}

export function listOtherIncome(db: Database.Database, year: number): OtherIncomeListItem[] {
  return db
    .prepare(
      `SELECT o.id, o.income_date, o.description, o.net_cents, o.tax_cents, o.gross_cents,
              c.name AS category_name, i.invoice_number
         FROM other_income o
         LEFT JOIN euer_categories c ON c.id = o.category_id
         LEFT JOIN invoices i ON i.id = o.invoice_id
        WHERE substr(o.income_date, 1, 4) = ?
        ORDER BY o.income_date DESC, o.id DESC`,
    )
    .all(String(year)) as OtherIncomeListItem[];
}
