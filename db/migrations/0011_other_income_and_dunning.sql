-- GoBDesk – Migration 0011:
--   (1) `other_income`: sonstige Betriebseinnahmen außerhalb einer Rechnung
--       (z. B. **Mahngebühren/Verzugszinsen**). Diese sind Betriebseinnahmen bei
--       Zufluss (§ 11 EStG), aber **ohne Umsatzsteuer** – echter Schadensersatz,
--       kein Leistungsaustausch. Sie dürfen deshalb NICHT als Zahlung auf die
--       Rechnung erfasst werden (dort würden sie mit dem USt-Split der Rechnung
--       belegt). Struktur bewusst analog zu `expenses`: korrigierbar, aber jede
--       Anlage/Änderung wird journalisiert und von `verifyGobd` abgeglichen.
--   (2) `dunning_notices`: Historie der erzeugten Mahnschreiben je Rechnung
--       (Stufe 1 = Zahlungserinnerung, 2 = 1. Mahnung, 3 = 2. Mahnung). Dient der
--       Stufen-Eskalation; das Schreiben selbst liegt als Dokument im DMS.

PRAGMA user_version = 11;

CREATE TABLE other_income (
    id           INTEGER PRIMARY KEY,
    income_date  TEXT    NOT NULL,          -- Zuflussdatum (EÜR-relevant)
    description  TEXT    NOT NULL,
    category_id  INTEGER NOT NULL REFERENCES euer_categories(id),
    net_cents    INTEGER NOT NULL,
    tax_rate_bp  INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0),
    tax_cents    INTEGER NOT NULL DEFAULT 0,
    gross_cents  INTEGER NOT NULL,
    invoice_id   INTEGER REFERENCES invoices(id),   -- optionaler Bezug (z. B. gemahnte Rechnung)
    note         TEXT,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_other_income_date    ON other_income(income_date);
CREATE INDEX idx_other_income_invoice ON other_income(invoice_id);

CREATE TABLE dunning_notices (
    id          INTEGER PRIMARY KEY,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
    level       INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
    fee_cents   INTEGER NOT NULL DEFAULT 0,
    document_id INTEGER REFERENCES documents(id),
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_dunning_notices_invoice ON dunning_notices(invoice_id);
