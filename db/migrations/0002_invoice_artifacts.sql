-- GoBDesk – Migration 0002: Ablage der generierten Rechnungs-Artefakte (PDF/XML).
-- Getrennt von der Rechnung, damit die festgeschriebene Rechnung unveränderbar
-- bleibt (die Sperr-Trigger blockieren UPDATE auf issued-Rechnungen).

PRAGMA user_version = 2;

CREATE TABLE invoice_artifacts (
    id          INTEGER PRIMARY KEY,
    invoice_id  INTEGER NOT NULL REFERENCES invoices(id),
    kind        TEXT    NOT NULL CHECK (kind IN ('pdf', 'xml')),
    path        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (invoice_id, kind)
) STRICT;

CREATE INDEX idx_invoice_artifacts_invoice ON invoice_artifacts(invoice_id);
