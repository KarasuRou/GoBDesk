/** Ausgaben (Belege) + EÜR-Auswertung. */

import type Database from "better-sqlite3";

import { appendAudit } from "../core/gobd.js";
import { roundDiv } from "../core/tax.js";
import type {
  EuerCategory,
  EuerReport,
  ExpenseDetail,
  ExpenseInput,
  ExpenseListItem,
} from "../shared/api.js";

function grossToNet(grossCents: number, rateBp: number): number {
  return roundDiv(grossCents * 10_000, 10_000 + rateBp);
}

export function listEuerCategories(db: Database.Database): EuerCategory[] {
  return db
    .prepare(
      "SELECT id, code, name, kind FROM euer_categories WHERE kind = 'expense' ORDER BY sort_order",
    )
    .all() as EuerCategory[];
}

export function createExpense(db: Database.Database, input: ExpenseInput): number {
  const description = input.description.trim();
  if (description.length === 0) throw new Error("Bitte eine Beschreibung angeben.");
  if (input.gross_cents <= 0) throw new Error("Der Bruttobetrag muss größer als 0 sein.");

  const net = grossToNet(input.gross_cents, input.tax_rate_bp);
  const row = {
    expense_date: input.expense_date,
    payment_date: input.payment_date,
    description,
    vendor: input.vendor?.trim() || null,
    category_id: input.category_id,
    net_cents: net,
    tax_rate_bp: input.tax_rate_bp,
    tax_cents: input.gross_cents - net,
    gross_cents: input.gross_cents,
    deductible_permille: input.deductible_permille,
    is_paid: input.payment_date ? 1 : 0,
    order_id: input.order_id ?? null,
  };

  const run = db.transaction((): number => {
    const info = db
      .prepare(
        `INSERT INTO expenses
           (expense_date, payment_date, description, vendor, category_id,
            net_cents, tax_rate_bp, tax_cents, gross_cents, deductible_permille, is_paid, order_id)
         VALUES (@expense_date, @payment_date, @description, @vendor, @category_id,
            @net_cents, @tax_rate_bp, @tax_cents, @gross_cents, @deductible_permille, @is_paid, @order_id)`,
      )
      .run(row);
    const id = Number(info.lastInsertRowid);
    // Vollständiger Snapshot im Journal: manipulationssicherer Soll-Zustand,
    // gegen den die GoBD-Prüfung die Tabelle abgleicht.
    appendAudit(db, "expense", id, "CREATE", expenseSnapshot(row));
    return id;
  });
  return run();
}

/** Fachlicher Zustand einer Ausgabe für den Journal-Snapshot (ohne is_paid/updated_at). */
function expenseSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  return {
    expense_date: row.expense_date,
    payment_date: row.payment_date,
    description: row.description,
    vendor: row.vendor,
    category_id: row.category_id,
    net_cents: row.net_cents,
    tax_cents: row.tax_cents,
    gross_cents: row.gross_cents,
    tax_rate_bp: row.tax_rate_bp,
    deductible_permille: row.deductible_permille,
    order_id: row.order_id,
  };
}

export function getExpense(db: Database.Database, id: number): ExpenseDetail | null {
  const row = db
    .prepare(
      `SELECT id, expense_date, payment_date, description, vendor, category_id,
              gross_cents, tax_rate_bp, deductible_permille, order_id
         FROM expenses WHERE id = ?`,
    )
    .get(id) as ExpenseDetail | undefined;
  return row ?? null;
}

/** Ändert eine Ausgabe und protokolliert die Korrektur in der Audit-Kette (GoBD). */
export function updateExpense(db: Database.Database, id: number, input: ExpenseInput): void {
  const description = input.description.trim();
  if (description.length === 0) throw new Error("Bitte eine Beschreibung angeben.");
  if (input.gross_cents <= 0) throw new Error("Der Bruttobetrag muss größer als 0 sein.");

  const net = grossToNet(input.gross_cents, input.tax_rate_bp);
  const row = {
    id,
    expense_date: input.expense_date,
    payment_date: input.payment_date,
    description,
    vendor: input.vendor?.trim() || null,
    category_id: input.category_id,
    net_cents: net,
    tax_rate_bp: input.tax_rate_bp,
    tax_cents: input.gross_cents - net,
    gross_cents: input.gross_cents,
    deductible_permille: input.deductible_permille,
    is_paid: input.payment_date ? 1 : 0,
    order_id: input.order_id ?? null,
    updated_at: new Date().toISOString(),
  };

  const run = db.transaction(() => {
    // Vorzustand sichern: der ursprüngliche Inhalt bleibt feststellbar (Rz. 58).
    const before = db
      .prepare(
        `SELECT expense_date, payment_date, description, vendor, category_id,
                net_cents, tax_cents, gross_cents, tax_rate_bp, deductible_permille, order_id
           FROM expenses WHERE id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    db.prepare(
      `UPDATE expenses SET
         expense_date = @expense_date, payment_date = @payment_date, description = @description,
         vendor = @vendor, category_id = @category_id, net_cents = @net_cents,
         tax_rate_bp = @tax_rate_bp, tax_cents = @tax_cents, gross_cents = @gross_cents,
         deductible_permille = @deductible_permille, is_paid = @is_paid, order_id = @order_id,
         updated_at = @updated_at
       WHERE id = @id`,
    ).run(row);
    appendAudit(db, "expense", id, "UPDATE", { ...expenseSnapshot(row), before });
  });
  run();
}

const EXPENSE_LIST_COLUMNS = `e.id, e.expense_date, e.description, e.vendor, e.net_cents,
  e.gross_cents, e.deductible_permille, c.name AS category_name`;

export function listExpenses(db: Database.Database, year: number): ExpenseListItem[] {
  return db
    .prepare(
      `SELECT ${EXPENSE_LIST_COLUMNS}
         FROM expenses e
         LEFT JOIN euer_categories c ON c.id = e.category_id
        WHERE substr(COALESCE(e.payment_date, e.expense_date), 1, 4) = ?
        ORDER BY COALESCE(e.payment_date, e.expense_date) DESC, e.id DESC`,
    )
    .all(String(year)) as ExpenseListItem[];
}

export function listExpensesForOrder(db: Database.Database, orderId: number): ExpenseListItem[] {
  return db
    .prepare(
      `SELECT ${EXPENSE_LIST_COLUMNS}
         FROM expenses e
         LEFT JOIN euer_categories c ON c.id = e.category_id
        WHERE e.order_id = ?
        ORDER BY COALESCE(e.payment_date, e.expense_date) DESC, e.id DESC`,
    )
    .all(orderId) as ExpenseListItem[];
}

/**
 * EÜR-Auswertung für ein Jahr nach Zufluss-/Abflussprinzip (§11 EStG).
 * Einnahmen zählen anteilig je Zahlung im Jahr ihres Zuflusses – eine Teilzahlung
 * wirkt also nur mit ihrem Anteil, der Rest erst im Jahr der nächsten Rate.
 * Netto/USt werden proportional zum gezahlten Bruttoanteil der Rechnung verteilt.
 * Ausgaben nach Zahlungs-/Belegdatum. Kleinunternehmer rechnen brutto; bei
 * Regelbesteuerung ist USt/Vorsteuer durchlaufend.
 */
export function euerReport(db: Database.Database, year: number): EuerReport {
  const y = String(year);
  const isKu =
    (db.prepare("SELECT is_kleinunternehmer AS k FROM company_settings WHERE id = 1").get() as {
      k: number;
    }).k === 1;

  // Einnahmen: jede Zahlung des Jahres steuert ihren Bruttoanteil bei; Netto und
  // USt der Rechnung werden im selben Verhältnis (paid / gross) angesetzt.
  // Stornierte Rechnungen bleiben einbezogen: erhaltene Zahlungen und spätere
  // Rückzahlungen (negative Beträge) sind reale Zu-/Abflüsse (§ 11 EStG).
  const paymentRows = db
    .prepare(
      `SELECT p.amount_cents AS paid, i.net_total_cents AS net,
              i.tax_total_cents AS ust, i.gross_total_cents AS gross
         FROM payments p
         JOIN invoices i ON i.id = p.invoice_id
        WHERE i.status IN ('issued', 'cancelled') AND substr(p.paid_at, 1, 4) = ?`,
    )
    .all(y) as Array<{ paid: number; net: number; ust: number; gross: number }>;

  const inc = { net: 0, ust: 0 };
  for (const p of paymentRows) {
    if (p.gross === 0) continue;
    inc.net += roundDiv(p.net * p.paid, p.gross);
    inc.ust += roundDiv(p.ust * p.paid, p.gross);
  }

  const rows = db
    .prepare(
      `SELECT c.name AS category, e.net_cents, e.tax_cents, e.gross_cents, e.deductible_permille
         FROM expenses e
         LEFT JOIN euer_categories c ON c.id = e.category_id
        WHERE substr(COALESCE(e.payment_date, e.expense_date), 1, 4) = ?`,
    )
    .all(y) as Array<{
    category: string | null;
    net_cents: number;
    tax_cents: number;
    gross_cents: number;
    deductible_permille: number;
  }>;

  const byCategory = new Map<string, number>();
  let expensesTotal = 0;
  let vorsteuer = 0;
  for (const r of rows) {
    const base = isKu ? r.gross_cents : r.net_cents;
    const amount = roundDiv(base * r.deductible_permille, 1000);
    const category = r.category ?? "Sonstiges";
    byCategory.set(category, (byCategory.get(category) ?? 0) + amount);
    expensesTotal += amount;
    if (!isKu) vorsteuer += roundDiv(r.tax_cents * r.deductible_permille, 1000);
  }

  const expenses = [...byCategory.entries()]
    .map(([category, amount_cents]) => ({ category, amount_cents }))
    .sort((a, b) => b.amount_cents - a.amount_cents);

  return {
    year,
    is_kleinunternehmer: isKu,
    income_net_cents: inc.net,
    ust_collected_cents: inc.ust,
    expenses,
    expenses_total_cents: expensesTotal,
    vorsteuer_cents: vorsteuer,
    profit_cents: inc.net - expensesTotal,
    ust_zahllast_cents: inc.ust - vorsteuer,
  };
}

/** Jahre mit EÜR-Bewegungen (Zahlungseingänge oder Ausgaben) – für die Jahresauswahl. */
export function listEuerYears(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT y FROM (
         SELECT CAST(substr(paid_at, 1, 4) AS INTEGER) AS y FROM payments WHERE paid_at IS NOT NULL
         UNION
         SELECT CAST(substr(COALESCE(payment_date, expense_date), 1, 4) AS INTEGER) AS y FROM expenses
       ) WHERE y IS NOT NULL
       ORDER BY y DESC`,
    )
    .all() as Array<{ y: number }>;
  return rows.map((r) => r.y);
}
