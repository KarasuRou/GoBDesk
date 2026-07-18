-- GoBDesk – Migration 0006: Storno-/Korrekturverfahren (GoBD Rz. 64, 93).
--   (1) cancels_invoice_id: die Stornorechnung referenziert das Original
--       (Rückbeziehbarkeit der Korrektur auf die ursprüngliche Buchung).
--   (2) invoice_items erlaubt negative Mengen (Stornopositionen spiegeln das
--       Original mit negierter Menge; EN 16931 BR-27 verbietet nur negative
--       PREISE, negative Mengen sind zulässig). CHECK-Änderung erfordert in
--       SQLite einen Tabellen-Neubau; die Item-Sperr-Trigger werden danach
--       neu angelegt und decken jetzt auch stornierte Rechnungen ab.
--   (3) Sperr-Trigger präzisiert: der EINZIGE erlaubte Übergang einer
--       festgeschriebenen Rechnung ist issued -> cancelled, bei dem
--       ausschließlich status/cancelled_by_invoice_id/updated_at geändert
--       werden. Stornierte Rechnungen sind vollständig unveränderbar.

PRAGMA user_version = 6;

ALTER TABLE invoices ADD COLUMN cancels_invoice_id INTEGER REFERENCES invoices(id);

-- ---------------------------------------------------------------------
-- invoice_items: CHECK (quantity_milli > 0) -> (quantity_milli != 0)
-- ---------------------------------------------------------------------
CREATE TABLE invoice_items_new (
    id                    INTEGER PRIMARY KEY,
    invoice_id            INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    position              INTEGER NOT NULL,
    description           TEXT    NOT NULL,
    quantity_milli        INTEGER NOT NULL CHECK (quantity_milli != 0),
    unit                  TEXT    NOT NULL DEFAULT 'Stk',
    unit_price_net_cents  INTEGER NOT NULL,
    tax_rate_bp           INTEGER NOT NULL DEFAULT 1900 CHECK (tax_rate_bp >= 0),
    line_net_cents        INTEGER,
    line_tax_cents        INTEGER,
    line_gross_cents      INTEGER,
    UNIQUE (invoice_id, position)
) STRICT;

INSERT INTO invoice_items_new SELECT * FROM invoice_items;
DROP TABLE invoice_items;
ALTER TABLE invoice_items_new RENAME TO invoice_items;
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TRIGGER trg_invoice_items_block_update
BEFORE UPDATE ON invoice_items
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) IN ('issued', 'cancelled')
BEGIN
    SELECT RAISE(ABORT, 'GoBD: Positionen einer festgeschriebenen Rechnung sind unveränderbar');
END;

CREATE TRIGGER trg_invoice_items_block_delete
BEFORE DELETE ON invoice_items
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) IN ('issued', 'cancelled')
BEGIN
    SELECT RAISE(ABORT, 'GoBD: Positionen einer festgeschriebenen Rechnung dürfen nicht gelöscht werden');
END;

-- ---------------------------------------------------------------------
-- Rechnungs-Sperr-Trigger: Storno-Übergang als einzige Ausnahme
-- ---------------------------------------------------------------------
DROP TRIGGER trg_invoices_block_update;

CREATE TRIGGER trg_invoices_block_update
BEFORE UPDATE ON invoices
WHEN OLD.status = 'issued' AND NOT (
    NEW.status = 'cancelled'
    AND OLD.cancelled_by_invoice_id IS NULL
    AND NEW.cancelled_by_invoice_id IS NOT NULL
    AND NEW.invoice_number IS OLD.invoice_number
    AND NEW.customer_id IS OLD.customer_id
    AND NEW.issue_date IS OLD.issue_date
    AND NEW.service_date IS OLD.service_date
    AND NEW.due_date IS OLD.due_date
    AND NEW.currency IS OLD.currency
    AND NEW.is_kleinunternehmer_snapshot IS OLD.is_kleinunternehmer_snapshot
    AND NEW.reverse_charge IS OLD.reverse_charge
    AND NEW.net_total_cents IS OLD.net_total_cents
    AND NEW.tax_total_cents IS OLD.tax_total_cents
    AND NEW.gross_total_cents IS OLD.gross_total_cents
    AND NEW.notes IS OLD.notes
    AND NEW.content_hash IS OLD.content_hash
    AND NEW.pdf_path IS OLD.pdf_path
    AND NEW.xml_path IS OLD.xml_path
    AND NEW.issued_at IS OLD.issued_at
    AND NEW.created_at IS OLD.created_at
    AND NEW.buyer_name_snapshot IS OLD.buyer_name_snapshot
    AND NEW.order_number_snapshot IS OLD.order_number_snapshot
    AND NEW.hash_version IS OLD.hash_version
    AND NEW.order_id IS OLD.order_id
    AND NEW.cancels_invoice_id IS OLD.cancels_invoice_id
)
BEGIN
    SELECT RAISE(ABORT, 'GoBD: festgeschriebene Rechnung ist unveränderbar (Korrektur nur per Storno)');
END;

CREATE TRIGGER trg_invoices_block_update_cancelled
BEFORE UPDATE ON invoices
WHEN OLD.status = 'cancelled'
BEGIN
    SELECT RAISE(ABORT, 'GoBD: stornierte Rechnung ist unveränderbar');
END;

DROP TRIGGER trg_invoices_block_delete;

CREATE TRIGGER trg_invoices_block_delete
BEFORE DELETE ON invoices
WHEN OLD.status IN ('issued', 'cancelled')
BEGIN
    SELECT RAISE(ABORT, 'GoBD: festgeschriebene Rechnung darf nicht gelöscht werden');
END;
