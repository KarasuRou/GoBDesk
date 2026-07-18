-- GoBDesk – Migration 0007: Empfangene E-Rechnungen komfortabel machen.
-- Beim DMS-Import wird geprüft, ob eine Datei eine E-Rechnung ist (ZUGFeRD/
-- Factur-X-PDF oder XRechnung-XML). Die extrahierten Kerndaten (Aussteller,
-- Nummer, Datum, Beträge) werden als JSON am Dokument gecacht – die Datei
-- selbst bleibt unverändert das Original (GoBD Rz. 131).

PRAGMA user_version = 7;

ALTER TABLE documents ADD COLUMN einvoice_json TEXT;
