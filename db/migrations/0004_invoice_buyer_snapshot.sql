-- GoBDesk – Migration 0004: Käufername zum Festschreibe-Zeitpunkt einfrieren.
-- Der content_hash einer festgeschriebenen Rechnung schließt den Käufernamen ein.
-- Da Kundennamen nachträglich änderbar sind, wird der Name hier separat eingefroren,
-- damit die GoBD-Integritätsprüfung den Hash exakt (und ohne Falsch-Alarm bei einer
-- späteren Kundenumbenennung) reproduzieren kann.

PRAGMA user_version = 4;

ALTER TABLE invoices ADD COLUMN buyer_name_snapshot TEXT;
