-- GoBDesk – Initiales Schema (SQLite)
-- Designprinzipien:
--   * Geldbeträge IMMER als INTEGER in Cent (keine Floats -> keine Rundungsfehler).
--   * Steuersätze als INTEGER in Basispunkten (bp): 19,00 % = 1900, 7,00 % = 700, 0 % = 0.
--   * Mengen als INTEGER in Tausendstel (milli): 1,000 Stück = 1000.
--   * Datums-/Zeitwerte als ISO-8601-TEXT (UTC bei Zeitstempeln).
--   * STRICT-Tabellen erzwingen die Typdisziplin (SQLite >= 3.37).
--
-- Beim Verbindungsaufbau in der App zu setzen:
--   PRAGMA journal_mode = WAL;
--   PRAGMA foreign_keys = ON;
--   PRAGMA busy_timeout = 5000;

PRAGMA user_version = 1;

-- =====================================================================
-- Firmen-/Systemeinstellungen (genau eine Zeile, id = 1)
-- =====================================================================
CREATE TABLE company_settings (
    id                     INTEGER PRIMARY KEY CHECK (id = 1),
    legal_name             TEXT    NOT NULL,
    address_line1          TEXT    NOT NULL,
    address_line2          TEXT,
    zip                    TEXT    NOT NULL,
    city                   TEXT    NOT NULL,
    country_iso            TEXT    NOT NULL DEFAULT 'DE',
    tax_number             TEXT,               -- Steuernummer
    vat_id                 TEXT,               -- USt-IdNr (leer bei reinem KU)
    is_kleinunternehmer    INTEGER NOT NULL DEFAULT 1 CHECK (is_kleinunternehmer IN (0, 1)),
    email                  TEXT,
    phone                  TEXT,
    iban                   TEXT,
    bic                    TEXT,
    bank_name              TEXT,
    logo_path              TEXT,
    invoice_footer         TEXT,
    default_payment_days   INTEGER NOT NULL DEFAULT 14,
    created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- =====================================================================
-- Konfigurierbare Steuersätze
-- =====================================================================
CREATE TABLE tax_rates (
    id           INTEGER PRIMARY KEY,
    name         TEXT    NOT NULL,
    rate_bp      INTEGER NOT NULL CHECK (rate_bp >= 0),   -- 1900 = 19 %
    is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
) STRICT;

INSERT INTO tax_rates (name, rate_bp, is_default, is_active) VALUES
    ('Regelsteuersatz 19 %', 1900, 1, 1),
    ('Ermäßigt 7 %',          700, 0, 1),
    ('0 % / steuerfrei',        0, 0, 1);

-- =====================================================================
-- Lückenlose Nummernkreise (§14 UStG: fortlaufende Rechnungsnummer)
-- Vergabe erst bei Festschreibung, atomar in einer Transaktion.
-- =====================================================================
CREATE TABLE number_sequences (
    scope       TEXT    NOT NULL,      -- z. B. 'invoice'
    period      TEXT    NOT NULL,      -- z. B. Jahr '2026'
    next_value  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (scope, period)
) STRICT;

-- =====================================================================
-- Kunden (in Paperless-Terminologie: "Correspondents")
-- =====================================================================
CREATE TABLE customers (
    id                   INTEGER PRIMARY KEY,
    customer_number      TEXT    UNIQUE,
    kind                 TEXT    NOT NULL DEFAULT 'company'
                                 CHECK (kind IN ('company', 'individual')),
    company_name         TEXT,
    contact_first_name   TEXT,
    contact_last_name    TEXT,
    address_line1        TEXT,
    address_line2        TEXT,
    zip                  TEXT,
    city                 TEXT,
    country_iso          TEXT    NOT NULL DEFAULT 'DE',
    vat_id               TEXT,               -- USt-IdNr des Kunden (B2B/Reverse-Charge)
    email                TEXT,
    phone                TEXT,
    -- Elektronische Adresse für EN 16931 (z. B. Leitweg-ID / Peppol / E-Mail)
    electronic_address        TEXT,
    electronic_address_scheme TEXT,          -- z. B. 'EM' (E-Mail), '0204' (Leitweg-ID)
    default_payment_days INTEGER,
    notes                TEXT,
    is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
    created_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at           TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    CHECK (company_name IS NOT NULL OR contact_last_name IS NOT NULL)
) STRICT;

-- =====================================================================
-- Rechnungen
-- Lifecycle-Status (GoBD): draft -> issued (festgeschrieben) -> cancelled
-- Ein festgeschriebener Datensatz wird per Trigger gegen UPDATE/DELETE gesperrt.
-- Zahlungen liegen in einer separaten Tabelle, damit die Rechnungszeile
-- nach Festschreibung wirklich eingefroren bleibt.
-- =====================================================================
CREATE TABLE invoices (
    id                            INTEGER PRIMARY KEY,
    invoice_number                TEXT    UNIQUE,   -- NULL bis zur Festschreibung
    customer_id                   INTEGER NOT NULL REFERENCES customers(id),
    status                        TEXT    NOT NULL DEFAULT 'draft'
                                          CHECK (status IN ('draft', 'issued', 'cancelled')),
    issue_date                    TEXT,             -- Rechnungsdatum
    service_date                  TEXT,             -- Leistungs-/Lieferdatum (Pflicht §14)
    due_date                      TEXT,
    currency                      TEXT    NOT NULL DEFAULT 'EUR',
    -- Steuermodus zum Zeitpunkt der Festschreibung eingefroren (nicht "live"!)
    is_kleinunternehmer_snapshot  INTEGER CHECK (is_kleinunternehmer_snapshot IN (0, 1)),
    reverse_charge                INTEGER NOT NULL DEFAULT 0 CHECK (reverse_charge IN (0, 1)),
    -- Beträge werden bei Festschreibung berechnet & eingefroren
    net_total_cents               INTEGER,
    tax_total_cents               INTEGER,
    gross_total_cents             INTEGER,
    notes                         TEXT,
    -- Referenz auf die Storno-/korrigierende Rechnung (Korrektur = neuer Beleg)
    cancelled_by_invoice_id       INTEGER REFERENCES invoices(id),
    content_hash                  TEXT,             -- SHA-256 der Kerndaten (bei issued)
    pdf_path                      TEXT,             -- generiertes hybrides PDF/A-3
    xml_path                      TEXT,             -- Factur-X/XRechnung-XML
    issued_at                     TEXT,
    created_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at                    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_invoices_customer ON invoices(customer_id);
CREATE INDEX idx_invoices_status   ON invoices(status);

-- =====================================================================
-- Rechnungspositionen
-- =====================================================================
CREATE TABLE invoice_items (
    id                    INTEGER PRIMARY KEY,
    invoice_id            INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    position              INTEGER NOT NULL,
    description           TEXT    NOT NULL,
    quantity_milli        INTEGER NOT NULL CHECK (quantity_milli > 0), -- 1000 = 1,000
    unit                  TEXT    NOT NULL DEFAULT 'Stk',
    unit_price_net_cents  INTEGER NOT NULL,
    tax_rate_bp           INTEGER NOT NULL DEFAULT 1900 CHECK (tax_rate_bp >= 0),
    -- bei Festschreibung eingefrorene Zeilensummen
    line_net_cents        INTEGER,
    line_tax_cents        INTEGER,
    line_gross_cents      INTEGER,
    UNIQUE (invoice_id, position)
) STRICT;

CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

-- =====================================================================
-- Zahlungen (Zufluss). Getrennt gehalten, um die Rechnung einzufrieren.
-- Relevant für die EÜR (Zufluss-/Abflussprinzip, §11 EStG).
-- =====================================================================
CREATE TABLE payments (
    id            INTEGER PRIMARY KEY,
    invoice_id    INTEGER NOT NULL REFERENCES invoices(id),
    paid_at       TEXT    NOT NULL,          -- Datum des Zuflusses
    amount_cents  INTEGER NOT NULL,
    method        TEXT,                      -- 'bank', 'cash', ...
    note          TEXT,
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_payments_invoice ON payments(invoice_id);

-- =====================================================================
-- EÜR-Kategorien (Anlage EÜR).
-- HINWEIS: euer_line orientiert sich an der Anlage EÜR, die Zeilennummern
-- ändern sich jährlich -> vor Produktivnutzung gegen das aktuelle Formular
-- prüfen. kind = 'income' | 'expense'.
-- =====================================================================
CREATE TABLE euer_categories (
    id          INTEGER PRIMARY KEY,
    code        TEXT    NOT NULL UNIQUE,
    name        TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('income', 'expense')),
    euer_line   TEXT,                        -- Referenz-Zeile im Formular
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_builtin  INTEGER NOT NULL DEFAULT 1 CHECK (is_builtin IN (0, 1))
) STRICT;

INSERT INTO euer_categories (code, name, kind, euer_line, sort_order) VALUES
    ('INC_REVENUE',   'Betriebseinnahmen (Umsatz)',            'income',  '15', 10),
    ('INC_VAT',       'Vereinnahmte Umsatzsteuer',             'income',  '16', 20),
    ('INC_OTHER',     'Sonstige Betriebseinnahmen',            'income',  '17', 30),
    ('EXP_GOODS',     'Waren, Roh- und Hilfsstoffe',           'expense', '26', 100),
    ('EXP_SERVICES',  'Bezogene Fremdleistungen',              'expense', '27', 110),
    ('EXP_STAFF',     'Personalkosten',                        'expense', '28', 120),
    ('EXP_DEPREC',    'Abschreibungen (AfA)',                  'expense', '29', 130),
    ('EXP_RENT',      'Raumkosten / Miete',                    'expense', '38', 140),
    ('EXP_INSURANCE', 'Versicherungen / Beiträge',             'expense', '46', 150),
    ('EXP_ADVERT',    'Werbekosten',                           'expense', '43', 160),
    ('EXP_TRAVEL',    'Reisekosten',                           'expense', '44', 170),
    ('EXP_VEHICLE',   'Kfz-Kosten',                            'expense', '41', 180),
    ('EXP_OFFICE',    'Bürobedarf / Porto / Telefon',          'expense', '47', 190),
    ('EXP_TRAINING',  'Fortbildung',                           'expense', '44', 200),
    ('EXP_FEES',      'Rechts-/Steuerberatung, Gebühren',      'expense', '48', 210),
    ('EXP_VAT_PAID',  'Gezahlte Vorsteuer / Umsatzsteuer',     'expense', '55', 220),
    ('EXP_OTHER',     'Sonstige Betriebsausgaben',             'expense', '51', 999);

-- =====================================================================
-- Ausgaben (Belege). Für KU brutto verbuchen (keine Vorsteuer).
-- =====================================================================
CREATE TABLE expenses (
    id                  INTEGER PRIMARY KEY,
    expense_date        TEXT    NOT NULL,        -- Belegdatum
    payment_date        TEXT,                    -- Abflussdatum (EÜR-relevant)
    description         TEXT    NOT NULL,
    vendor              TEXT,
    category_id         INTEGER NOT NULL REFERENCES euer_categories(id),
    net_cents           INTEGER NOT NULL,
    tax_rate_bp         INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp >= 0),
    tax_cents           INTEGER NOT NULL DEFAULT 0,   -- Vorsteuer (bei KU 0/irrelevant)
    gross_cents         INTEGER NOT NULL,
    deductible_permille INTEGER NOT NULL DEFAULT 1000  -- 1000 = 100 % abziehbar
                                CHECK (deductible_permille BETWEEN 0 AND 1000),
    is_paid             INTEGER NOT NULL DEFAULT 0 CHECK (is_paid IN (0, 1)),
    document_id         INTEGER,                 -- Beleg (FK gesetzt, sobald DMS aktiv)
    created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_expenses_category ON expenses(category_id);
CREATE INDEX idx_expenses_date     ON expenses(payment_date);

-- =====================================================================
-- Revisionssicheres Audit-Log (Append-Only + Hash-Kette)
-- Jeder Eintrag verkettet über prev_hash den Vorgänger -> nachträgliches
-- Löschen/Umsortieren wird erkennbar. UPDATE/DELETE per Trigger gesperrt.
-- =====================================================================
CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,   -- monoton, keine Wiederverwendung
    created_at    TEXT    NOT NULL,
    entity_type   TEXT    NOT NULL,
    entity_id     INTEGER NOT NULL,
    action        TEXT    NOT NULL,                    -- 'ISSUE', 'CANCEL', ...
    payload_json  TEXT    NOT NULL,                    -- kanonische Kerndaten
    prev_hash     TEXT    NOT NULL,                    -- record_hash des Vorgängers ('' beim Genesis)
    record_hash   TEXT    NOT NULL UNIQUE,             -- SHA-256(prev_hash | payload_json)
    app_version   TEXT
) STRICT;

CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-- =====================================================================
-- GoBD-Sperrlogik (Trigger)
-- =====================================================================

-- Festgeschriebene Rechnungen: kein UPDATE, kein DELETE.
CREATE TRIGGER trg_invoices_block_update
BEFORE UPDATE ON invoices
WHEN OLD.status = 'issued'
BEGIN
    SELECT RAISE(ABORT, 'GoBD: festgeschriebene Rechnung ist unveränderbar');
END;

CREATE TRIGGER trg_invoices_block_delete
BEFORE DELETE ON invoices
WHEN OLD.status = 'issued'
BEGIN
    SELECT RAISE(ABORT, 'GoBD: festgeschriebene Rechnung darf nicht gelöscht werden');
END;

-- Positionen einer festgeschriebenen Rechnung ebenfalls sperren.
CREATE TRIGGER trg_invoice_items_block_update
BEFORE UPDATE ON invoice_items
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) = 'issued'
BEGIN
    SELECT RAISE(ABORT, 'GoBD: Positionen einer festgeschriebenen Rechnung sind unveränderbar');
END;

CREATE TRIGGER trg_invoice_items_block_delete
BEFORE DELETE ON invoice_items
WHEN (SELECT status FROM invoices WHERE id = OLD.invoice_id) = 'issued'
BEGIN
    SELECT RAISE(ABORT, 'GoBD: Positionen einer festgeschriebenen Rechnung dürfen nicht gelöscht werden');
END;

-- Audit-Log ist strikt append-only.
CREATE TRIGGER trg_audit_block_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'GoBD: audit_log ist append-only');
END;

CREATE TRIGGER trg_audit_block_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'GoBD: audit_log ist append-only');
END;

-- =====================================================================
-- Dokumentenmanagement (Paperless-artig) – Schema jetzt, Feature v1.1
-- =====================================================================
CREATE TABLE document_types (
    id          INTEGER PRIMARY KEY,
    name        TEXT    NOT NULL UNIQUE,
    is_builtin  INTEGER NOT NULL DEFAULT 1 CHECK (is_builtin IN (0, 1))
) STRICT;

INSERT INTO document_types (name) VALUES
    ('Vertrag'), ('Rechnung'), ('Beleg'), ('Angebot'), ('Mahnung'), ('Sonstiges');

CREATE TABLE tags (
    id     INTEGER PRIMARY KEY,
    name   TEXT NOT NULL UNIQUE,
    color  TEXT
) STRICT;

CREATE TABLE documents (
    id                INTEGER PRIMARY KEY,
    title             TEXT    NOT NULL,
    original_filename TEXT,
    stored_path       TEXT    NOT NULL,     -- verwalteter Ablageort (content-hash-basiert)
    content_sha256    TEXT    NOT NULL,     -- Dublettenerkennung
    mime_type         TEXT,
    file_size         INTEGER,
    document_type_id  INTEGER REFERENCES document_types(id),
    customer_id       INTEGER REFERENCES customers(id),
    doc_date          TEXT,                 -- Datum auf dem Dokument
    ocr_text          TEXT,                 -- Volltext aus OCR (via Python-Sidecar)
    is_archived       INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
    added_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE INDEX idx_documents_customer ON documents(customer_id);
CREATE INDEX idx_documents_hash     ON documents(content_sha256);

CREATE TABLE document_tags (
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id       INTEGER NOT NULL REFERENCES tags(id)      ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
) STRICT;

-- Polymorphe Verknüpfung: ein Dokument (z. B. Vertrag) kann an Kunde UND
-- Rechnung/Ausgabe hängen.
CREATE TABLE document_links (
    id           INTEGER PRIMARY KEY,
    document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    target_type  TEXT    NOT NULL CHECK (target_type IN ('customer', 'invoice', 'expense')),
    target_id    INTEGER NOT NULL,
    UNIQUE (document_id, target_type, target_id)
) STRICT;

CREATE INDEX idx_document_links_target ON document_links(target_type, target_id);

-- Volltextsuche über Dokumente (SQLite FTS5, externer Content).
CREATE VIRTUAL TABLE documents_fts USING fts5(
    title,
    ocr_text,
    content='documents',
    content_rowid='id'
);

CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
    INSERT INTO documents_fts(rowid, title, ocr_text)
    VALUES (new.id, new.title, new.ocr_text);
END;

CREATE TRIGGER documents_ad AFTER DELETE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, ocr_text)
    VALUES ('delete', old.id, old.title, old.ocr_text);
END;

CREATE TRIGGER documents_au AFTER UPDATE ON documents BEGIN
    INSERT INTO documents_fts(documents_fts, rowid, title, ocr_text)
    VALUES ('delete', old.id, old.title, old.ocr_text);
    INSERT INTO documents_fts(rowid, title, ocr_text)
    VALUES (new.id, new.title, new.ocr_text);
END;
