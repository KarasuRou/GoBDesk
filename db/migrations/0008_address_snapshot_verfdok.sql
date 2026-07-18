-- GoBDesk – Migration 0008: Käuferanschrift-Snapshot + Verfahrensdok-Texte.
--   (1) buyer_address_snapshot: die Rechnungsanschrift wird bei Festschreibung
--       zusätzlich zur Datei-Archivierung datenbankseitig eingefroren und ab
--       hash_version 4 in die Beleg-Prüfsumme einbezogen (GoBD Rz. 76:
--       inhaltlich identisches Mehrstück bleibt auch aus den Tabellendaten
--       reproduzierbar, unabhängig von späteren Stammdaten-Änderungen).
--   (2) Sperr-Trigger neu aufgebaut, damit der Snapshot beim einzigen
--       erlaubten Übergang (issued -> cancelled) mit abgesichert ist.
--   (3) verfdok_texts: vom Anwender hinterlegte organisatorische Angaben für
--       den Verfahrensdokumentations-Generator (werden beim Export direkt in
--       das Dokument eingesetzt und für den nächsten Export vorgehalten).

PRAGMA user_version = 8;

ALTER TABLE invoices ADD COLUMN buyer_address_snapshot TEXT;

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
)
BEGIN
    SELECT RAISE(ABORT, 'GoBD: festgeschriebene Rechnung ist unveränderbar (Korrektur nur per Storno)');
END;

CREATE TABLE verfdok_texts (
    key         TEXT NOT NULL PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
) STRICT;
