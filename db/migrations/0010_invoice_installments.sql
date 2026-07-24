-- GoBDesk – Migration 0010: Ratenplan (Soll-Zahlungsplan) an der Rechnung.
--   Rein SOLL-Daten (vereinbarte Raten mit Fälligkeit) – strikt getrennt vom IST
--   (tatsächliche Zahlungseingänge in `payments`, EÜR-relevant nach Zuflussprinzip).
--   Ein Ratenplan wird NIEMALS als Zufluss gebucht; er ist nur die Zahlungs-
--   vereinbarung. Auf der Rechnung als Zahlungsbedingung ausgewiesen und mit dem
--   Beleg eingefroren – die Sperr-Trigger verhindern Änderung/Löschung nach
--   Festschreibung (analog invoice_items).

PRAGMA user_version = 10;

CREATE TABLE invoice_installments (
    id           INTEGER PRIMARY KEY,
    invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,           -- 1..n, Ratennummer/Reihenfolge
    due_date     TEXT    NOT NULL,           -- Fälligkeit (ISO-8601)
    amount_cents INTEGER NOT NULL,
    UNIQUE (invoice_id, seq)
) STRICT;

CREATE INDEX idx_invoice_installments_invoice ON invoice_installments(invoice_id);

CREATE TRIGGER trg_invoice_installments_block_update
BEFORE UPDATE ON invoice_installments
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) IN ('issued', 'cancelled')
BEGIN
    SELECT RAISE(ABORT, 'GoBD: Ratenplan einer festgeschriebenen Rechnung ist unveränderbar');
END;

CREATE TRIGGER trg_invoice_installments_block_delete
BEFORE DELETE ON invoice_installments
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) IN ('issued', 'cancelled')
BEGIN
    SELECT RAISE(ABORT, 'GoBD: Ratenplan einer festgeschriebenen Rechnung darf nicht gelöscht werden');
END;
