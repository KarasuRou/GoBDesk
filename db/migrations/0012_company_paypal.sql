-- GoBDesk – Migration 0012: PayPal als zweite Zahlungsmöglichkeit in den Firmendaten.
--   Reine Stammdatenspalte (wie iban/bic): erscheint im Rechnungs- und Mahnfuß als
--   alternativer Zahlweg. Keine GoBD-Relevanz für die Unveränderbarkeit – die
--   Angabe wird beim Festschreiben in PDF/XML eingefroren, der Beleg selbst bleibt
--   über content_hash und Artefakt-Prüfsummen abgesichert. company_settings trägt
--   keine Sperr-Trigger, daher genügt ein ALTER TABLE.

PRAGMA user_version = 12;

ALTER TABLE company_settings ADD COLUMN paypal TEXT;  -- E-Mail-Adresse oder PayPal.Me-Link
