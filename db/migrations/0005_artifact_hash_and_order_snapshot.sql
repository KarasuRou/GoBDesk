-- GoBDesk – Migration 0005:
--   (1) Byte-genaue Integritätsprüfung der Rechnungsdateien: SHA-256 + Größe je
--       Artefakt werden bei der Festschreibung gespeichert und später neu geprüft.
--   (2) Auftragsnummer zum Festschreibe-Zeitpunkt einfrieren (order_number_snapshot),
--       damit sie – wie der Käufername – Teil des unveränderbaren Belegs ist.
--   (3) hash_version markiert das Format des content_hash. Bestehende (vor dieser
--       Migration festgeschriebene) Rechnungen bleiben so ohne Falsch-Alarm prüfbar:
--       NULL/1 = altes Format, 2 = Format inkl. Auftragsnummer.

PRAGMA user_version = 5;

ALTER TABLE invoice_artifacts ADD COLUMN sha256    TEXT;
ALTER TABLE invoice_artifacts ADD COLUMN byte_size INTEGER;

ALTER TABLE invoices ADD COLUMN order_number_snapshot TEXT;
ALTER TABLE invoices ADD COLUMN hash_version          INTEGER;
