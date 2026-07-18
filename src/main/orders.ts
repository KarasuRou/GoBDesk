/** Aufträge (Orders): organisatorische Klammer über Rechnungen/Dokumente/Ausgaben. */

import type Database from "better-sqlite3";

import type {
  OrderDetail,
  OrderFilter,
  OrderInput,
  OrderListItem,
  OrderOption,
} from "../shared/api.js";
import { listDocumentsForOrder } from "./documents.js";
import { listExpensesForOrder } from "./expenses.js";
import { listInvoices } from "./invoices.js";

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t.length ? t : null;
};

/** Nächste freie Auftragsnummer (JAHR-A####) – nur Vorschlag, verbraucht nichts. */
export function suggestOrderNumber(db: Database.Database): string {
  const year = new Date().getFullYear();
  const row = db
    .prepare("SELECT next_value AS n FROM number_sequences WHERE scope = 'order' AND period = ?")
    .get(String(year)) as { n: number } | undefined;
  return `${year}-A${String((row?.n ?? 0) + 1).padStart(4, "0")}`;
}

function consumeOrderNumber(db: Database.Database): string {
  const year = String(new Date().getFullYear());
  db.prepare(
    `INSERT INTO number_sequences (scope, period, next_value) VALUES ('order', ?, 1)
       ON CONFLICT(scope, period) DO UPDATE SET next_value = next_value + 1`,
  ).run(year);
  const n = (
    db
      .prepare("SELECT next_value AS n FROM number_sequences WHERE scope = 'order' AND period = ?")
      .get(year) as { n: number }
  ).n;
  return `${year}-A${String(n).padStart(4, "0")}`;
}

function assertTitle(input: OrderInput): string {
  const title = input.title.trim();
  if (title.length === 0) throw new Error("Bitte einen Titel angeben.");
  return title;
}

export function createOrder(db: Database.Database, input: OrderInput): number {
  const title = assertTitle(input);
  const number = clean(input.order_number) ?? consumeOrderNumber(db);
  try {
    const info = db
      .prepare(
        `INSERT INTO orders (order_number, customer_id, title, status, order_date, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(number, input.customer_id ?? null, title, input.status, clean(input.order_date), clean(input.notes));
    return Number(info.lastInsertRowid);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new Error(`Auftragsnummer „${number}" existiert bereits.`);
    throw err;
  }
}

export function updateOrder(db: Database.Database, id: number, input: OrderInput): void {
  const title = assertTitle(input);
  const number = clean(input.order_number);
  if (!number) throw new Error("Bitte eine Auftragsnummer angeben.");
  try {
    db.prepare(
      `UPDATE orders SET order_number = ?, customer_id = ?, title = ?, status = ?,
         order_date = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).run(number, input.customer_id ?? null, title, input.status, clean(input.order_date), clean(input.notes), new Date().toISOString(), id);
  } catch (err) {
    if (String(err).includes("UNIQUE")) throw new Error(`Auftragsnummer „${number}" existiert bereits.`);
    throw err;
  }
}

export function listOrders(db: Database.Database, filter: OrderFilter = {}): OrderListItem[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.status) {
    where.push("o.status = @status");
    params.status = filter.status;
  }
  const q = (filter.search ?? "").trim();
  if (q) {
    where.push("(o.order_number LIKE @like OR o.title LIKE @like OR c.company_name LIKE @like)");
    params.like = `%${q}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const stmt = db.prepare(
    `SELECT o.id, o.order_number, o.title, o.status, o.order_date,
            c.company_name AS customer_name,
            (SELECT COUNT(*) FROM invoices  i WHERE i.order_id = o.id) AS invoice_count,
            (SELECT COUNT(*) FROM documents d WHERE d.order_id = o.id) AS document_count,
            (SELECT COUNT(*) FROM expenses  e WHERE e.order_id = o.id) AS expense_count
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       ${whereSql}
      ORDER BY o.id DESC`,
  );
  return (Object.keys(params).length ? stmt.all(params) : stmt.all()) as OrderListItem[];
}

export function getOrder(db: Database.Database, id: number): OrderDetail | null {
  const row = db
    .prepare(
      `SELECT o.id, o.order_number, o.customer_id, o.title, o.status, o.order_date, o.notes,
              c.company_name AS customer_name
         FROM orders o
         LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = ?`,
    )
    .get(id) as Omit<OrderDetail, "invoices" | "documents" | "expenses"> | undefined;
  if (!row) return null;
  return {
    ...row,
    invoices: listInvoices(db, { orderId: id }),
    documents: listDocumentsForOrder(db, id),
    expenses: listExpensesForOrder(db, id),
  };
}

export function listOrderOptions(db: Database.Database): OrderOption[] {
  return (
    db.prepare("SELECT id, order_number, title FROM orders ORDER BY id DESC").all() as Array<{
      id: number;
      order_number: string;
      title: string;
    }>
  ).map((o) => ({ id: o.id, label: `${o.order_number} — ${o.title}` }));
}

/**
 * Löscht einen Auftrag. Blockiert, wenn festgeschriebene Rechnungen daran hängen
 * (die sind GoBD-gesperrt); ansonsten werden Entwürfe/Dokumente/Ausgaben gelöst.
 */
export function deleteOrder(db: Database.Database, id: number): void {
  const issued = (
    db
      .prepare("SELECT COUNT(*) AS c FROM invoices WHERE order_id = ? AND status = 'issued'")
      .get(id) as { c: number }
  ).c;
  if (issued > 0) {
    throw new Error("Auftrag hat festgeschriebene Rechnungen und kann nicht gelöscht werden.");
  }
  const run = db.transaction(() => {
    db.prepare("UPDATE invoices SET order_id = NULL WHERE order_id = ? AND status = 'draft'").run(id);
    db.prepare("UPDATE documents SET order_id = NULL WHERE order_id = ?").run(id);
    db.prepare("UPDATE expenses SET order_id = NULL WHERE order_id = ?").run(id);
    db.prepare("DELETE FROM orders WHERE id = ?").run(id);
  });
  run();
}
