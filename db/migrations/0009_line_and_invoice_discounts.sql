-- GoBDesk – Migration 0009: Rabatte & Aufpreise.
--   (1) Positions-Zu-/Abschläge (EN 16931 BG-27 Allowance / BG-28 Charge):
--       je Position optional ein Rabatt UND ein Aufpreis, jeweils prozentual
--       (Wert in Basispunkten) oder absolut (Wert in Cent) mit optionalem Grund.
--   (2) Rechnungsweiter Rabatt (EN 16931 BG-20 Document allowance): prozentual
--       oder absolut auf die Summe der Positions-Nettobeträge.
--   (3) Sperr-Trigger neu aufgebaut, damit der Rechnungs-Rabatt beim einzigen
--       erlaubten Übergang (issued -> cancelled) mit abgesichert/eingefroren ist.
--
-- Die Zu-/Abschläge gehen bei der Festschreibung in die eingefrorenen
-- Zeilensummen (line_net_cents) und Gesamtbeträge ein und werden ab
-- hash_version 5 in die Beleg-Prüfsumme einbezogen (siehe core/gobd.ts).
-- Positions-Spalten sind über die bestehenden invoice_items-Sperr-Trigger
-- (spaltenunabhängig, Migration 0006) automatisch mit eingefroren.

PRAGMA user_version = 9;

-- --- Positionsebene -------------------------------------------------------
ALTER TABLE invoice_items ADD COLUMN discount_type   TEXT CHECK (discount_type   IN ('percent', 'amount'));
ALTER TABLE invoice_items ADD COLUMN discount_value  INTEGER;   -- bp (percent) oder Cent (amount)
ALTER TABLE invoice_items ADD COLUMN discount_reason TEXT;
ALTER TABLE invoice_items ADD COLUMN surcharge_type   TEXT CHECK (surcharge_type   IN ('percent', 'amount'));
ALTER TABLE invoice_items ADD COLUMN surcharge_value  INTEGER;  -- bp (percent) oder Cent (amount)
ALTER TABLE invoice_items ADD COLUMN surcharge_reason TEXT;

-- --- Rechnungsebene -------------------------------------------------------
ALTER TABLE invoices ADD COLUMN discount_type   TEXT CHECK (discount_type IN ('percent', 'amount'));
ALTER TABLE invoices ADD COLUMN discount_value  INTEGER;        -- bp (percent) oder Cent (amount)
ALTER TABLE invoices ADD COLUMN discount_reason TEXT;

-- --- Sperr-Trigger neu: Rechnungs-Rabatt in die Storno-Whitelist aufnehmen -
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
    AND NEW.buyer_address_snapshot IS OLD.buyer_address_snapshot
    AND NEW.order_number_snapshot IS OLD.order_number_snapshot
    AND NEW.hash_version IS OLD.hash_version
    AND NEW.order_id IS OLD.order_id
    AND NEW.cancels_invoice_id IS OLD.cancels_invoice_id
    AND NEW.discount_type IS OLD.discount_type
    AND NEW.discount_value IS OLD.discount_value
    AND NEW.discount_reason IS OLD.discount_reason
)
BEGIN
    SELECT RAISE(ABORT, 'GoBD: festgeschriebene Rechnung ist unveränderbar (Korrektur nur per Storno)');
END;
