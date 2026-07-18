-- GoBDesk – Migration 0003: Aufträge (Orders) als organisatorische Klammer.
-- Ein Auftrag bündelt Rechnungen, Dokumente und Ausgaben. Die Zuordnung ist reine
-- Metadaten: order_id wird am Entwurf gesetzt und mit der Festschreibung eingefroren,
-- die festgeschriebene Rechnung bleibt dadurch unverändert (GoBD).

PRAGMA user_version = 3;

CREATE TABLE orders (
    id            INTEGER PRIMARY KEY,
    order_number  TEXT    NOT NULL UNIQUE,
    customer_id   INTEGER REFERENCES customers(id),
    title         TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'offen'
                          CHECK (status IN ('offen', 'in_arbeit', 'abgeschlossen', 'storniert')),
    order_date    TEXT,
    notes         TEXT,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_orders_customer ON orders(customer_id);

-- Zuordnung (1 Auftrag -> n Rechnungen/Dokumente/Ausgaben).
ALTER TABLE invoices  ADD COLUMN order_id INTEGER REFERENCES orders(id);
ALTER TABLE documents ADD COLUMN order_id INTEGER REFERENCES orders(id);
ALTER TABLE expenses  ADD COLUMN order_id INTEGER REFERENCES orders(id);

CREATE INDEX idx_invoices_order  ON invoices(order_id);
CREATE INDEX idx_documents_order ON documents(order_id);
CREATE INDEX idx_expenses_order  ON expenses(order_id);
