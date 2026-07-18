/**
 * Prüfer-Gesamtexport für den Datenzugriff per Datenüberlassung
 * (GoBD Rz. 158 ff., „Z3"; seit der GoBD-Änderung 2024 „Datenüberlassung"
 * statt „Datenträgerüberlassung"): alle steuerrelevanten Tabellen als CSV in
 * maschinell auswertbarer Form plus eine Datensatzbeschreibung
 * (Strukturinformationen, Rz. 176).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { CSV_BOM, toCsv } from "./csv.js";

/** Exportierte Tabellen mit Kurzbeschreibung für die Datensatzbeschreibung. */
const TABLES: Record<string, string> = {
  company_settings: "Firmen-/Steuereinstellungen des Unternehmens (eine Zeile).",
  customers: "Kundenstammdaten (Debitoren).",
  tax_rates: "Konfigurierte Umsatzsteuersätze.",
  orders: "Aufträge (Klammer über Rechnungen, Dokumente und Ausgaben).",
  invoices:
    "Ausgangsrechnungen. status: draft = Entwurf, issued = festgeschrieben, cancelled = storniert. " +
    "content_hash = SHA-256-Prüfsumme der eingefrorenen Kerndaten; cancels_invoice_id verweist bei " +
    "Stornorechnungen auf das stornierte Original, cancelled_by_invoice_id am Original auf den Stornobeleg.",
  invoice_items: "Rechnungspositionen (bei Festschreibung eingefrorene Zeilensummen).",
  invoice_artifacts:
    "Erzeugte Rechnungsdateien (PDF/A-3 mit eingebettetem EN-16931-XML sowie separates XML) " +
    "inkl. SHA-256 und Dateigröße.",
  payments: "Zahlungen zu Rechnungen (Zuflussprinzip § 11 EStG); negative Beträge = Rückzahlungen.",
  euer_categories: "EÜR-Kategorien (angelehnt an die Anlage EÜR).",
  expenses: "Betriebsausgaben (Belege) mit EÜR-Kategorie (Abflussprinzip § 11 EStG).",
  documents:
    "Dokumentenmanagement: aufbewahrte Unterlagen mit Ablagepfad und SHA-256-Prüfsumme (content_sha256).",
  document_links: "Polymorphe Verknüpfung Dokument ↔ Kunde/Rechnung/Ausgabe (Belegzuordnung).",
  document_tags: "Zuordnung Dokument ↔ Tag.",
  tags: "Frei vergebene Schlagworte.",
  document_types: "Dokumentarten (Vertrag, Rechnung, Beleg, …).",
  number_sequences: "Lückenlose Nummernkreise (Rechnungs-/Auftragsnummern) je Jahr.",
  audit_log:
    "Revisionssicheres Journal (append-only): jeder Eintrag verkettet den Vorgänger über " +
    "record_hash = SHA-256(prev_hash | payload_json).",
};

const CONVENTIONS = `# GoBDesk – Datensatzbeschreibung (Datenüberlassung Z3)

Dieser Export enthält alle steuerrelevanten Daten der Anwendung GoBDesk in
maschinell auswertbarer Form (CSV) einschließlich der Strukturinformationen
(GoBD Rz. 176). Quelle ist die SQLite-Datenbank der Anwendung; die Datei
\`gobdesk.sqlite\` einer Datensicherung enthält dieselben Daten in relationaler Form.

Für den Direktimport in die Prüfsoftware (z. B. IDEA) liegen zusätzlich
\`index.xml\` (Beschreibungsstandard zur Datenträgerüberlassung: Spaltentypen,
Primär-/Fremdschlüssel) und \`gdpdu-01-08-2002.dtd\` bei.

## Konventionen

- **Trennzeichen:** Semikolon (;), Kodierung UTF-8 mit BOM, Zeilenende CRLF.
  Werte mit Sonderzeichen sind nach RFC 4180 in doppelte Anführungszeichen gesetzt.
- **Geldbeträge:** ganzzahlig in **Cent** (Spaltensuffix \`_cents\`). 11900 = 119,00 EUR.
- **Steuersätze:** ganzzahlig in **Basispunkten** (Suffix \`_bp\`). 1900 = 19,00 %.
- **Mengen:** ganzzahlig in **Tausendsteln** (Suffix \`_milli\`). 1000 = 1,000 Einheiten.
- **Datums-/Zeitwerte:** ISO 8601 (\`JJJJ-MM-TT\` bzw. \`JJJJ-MM-TTThh:mm:ss.sssZ\`, UTC).
- **Boolesche Werte:** 0 = nein, 1 = ja (z. B. \`is_kleinunternehmer\`, \`is_archived\`).
- **Schlüssel:** Spalte \`id\` ist der Primärschlüssel; Spalten mit Suffix \`_id\`
  verweisen auf die \`id\` der gleichnamigen Tabelle (z. B. \`customer_id\` → customers.id).

## Integritätsnachweis

- \`invoices.content_hash\`: SHA-256 über die kanonisch serialisierten Kerndaten der
  festgeschriebenen Rechnung (Format siehe \`hash_version\`).
- \`audit_log\`: Hash-Kette; \`record_hash = SHA-256(prev_hash || '|' || payload_json)\`,
  \`prev_hash\` = \`record_hash\` des vorherigen Eintrags ('' beim ersten).
- \`invoice_artifacts.sha256\` / \`documents.content_sha256\`: SHA-256 der abgelegten Datei.

## Tabellen

`;

export interface Z3ExportData {
  path: string;
  files: number;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * DTD im Stil des Beschreibungsstandards zur Datenträgerüberlassung
 * (gdpdu-01-08-2002). Kompatible, auf die hier genutzten Elemente beschränkte
 * Fassung – bei Bedarf durch die offizielle Audicon-DTD ersetzbar (Dateiname
 * und Struktur sind darauf ausgelegt).
 */
const GDPDU_DTD = `<!-- Beschreibungsstandard Datentraegerueberlassung (kompatible Fassung, GoBDesk) -->
<!ELEMENT DataSet (Version?, DataSupplier?, Media+)>
<!ELEMENT Version (#PCDATA)>
<!ELEMENT DataSupplier (Name, Location?, Comment?)>
<!ELEMENT Media (Name, Table*)>
<!ELEMENT Table (URL, Name?, Description?, Range?, VariableLength)>
<!ELEMENT URL (#PCDATA)>
<!ELEMENT Name (#PCDATA)>
<!ELEMENT Location (#PCDATA)>
<!ELEMENT Comment (#PCDATA)>
<!ELEMENT Description (#PCDATA)>
<!ELEMENT Range (From, To?)>
<!ELEMENT From (#PCDATA)>
<!ELEMENT To (#PCDATA)>
<!ELEMENT VariableLength (ColumnDelimiter?, RecordDelimiter?, TextEncapsulator?, VariablePrimaryKey*, VariableColumn*, ForeignKey*)>
<!ELEMENT ColumnDelimiter (#PCDATA)>
<!ELEMENT RecordDelimiter (#PCDATA)>
<!ELEMENT TextEncapsulator (#PCDATA)>
<!ELEMENT VariablePrimaryKey (Name, Description?, (AlphaNumeric | Numeric | Date))>
<!ELEMENT VariableColumn (Name, Description?, (AlphaNumeric | Numeric | Date))>
<!ELEMENT ForeignKey (Name+, References)>
<!ELEMENT References (#PCDATA)>
<!ELEMENT AlphaNumeric EMPTY>
<!ELEMENT Numeric EMPTY>
<!ELEMENT Date EMPTY>
`;

interface ColumnInfo {
  name: string;
  type: string;
  pk: number;
}

interface FkInfo {
  from: string;
  table: string;
}

/** Baut die index.xml (Beschreibungsstandard) für den IDEA-Direktimport. */
function buildIndexXml(
  db: Database.Database,
  supplierName: string,
  tables: string[],
): string {
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE DataSet SYSTEM "gdpdu-01-08-2002.dtd">`,
    `<DataSet>`,
    `  <Version>1.0</Version>`,
    `  <DataSupplier>`,
    `    <Name>${xmlEscape(supplierName)}</Name>`,
    `    <Comment>GoBDesk Z3-Datenexport (Datenueberlassung, GoBD Rz. 158 ff.)</Comment>`,
    `  </DataSupplier>`,
    `  <Media>`,
    `    <Name>GoBDesk-Datenexport</Name>`,
  ];

  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
    const fks = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as FkInfo[]).filter((fk) =>
      tables.includes(fk.table),
    );
    parts.push(
      `    <Table>`,
      `      <URL>${table}.csv</URL>`,
      `      <Name>${table}</Name>`,
      `      <Description>${xmlEscape(TABLES[table] ?? table)}</Description>`,
      `      <Range><From>2</From></Range>`, // Zeile 1 ist die Kopfzeile
      `      <VariableLength>`,
      `        <ColumnDelimiter>;</ColumnDelimiter>`,
      `        <RecordDelimiter>&#13;&#10;</RecordDelimiter>`,
      `        <TextEncapsulator>"</TextEncapsulator>`,
    );
    for (const col of columns) {
      const kind = col.pk > 0 ? "VariablePrimaryKey" : "VariableColumn";
      const type = col.type.toUpperCase().includes("INT") ? "Numeric" : "AlphaNumeric";
      parts.push(`        <${kind}><Name>${xmlEscape(col.name)}</Name><${type}/></${kind}>`);
    }
    for (const fk of fks) {
      parts.push(
        `        <ForeignKey><Name>${xmlEscape(fk.from)}</Name><References>${xmlEscape(fk.table)}</References></ForeignKey>`,
      );
    }
    parts.push(`      </VariableLength>`, `    </Table>`);
  }

  parts.push(`  </Media>`, `</DataSet>`, ``);
  return parts.join("\n");
}

export function exportZ3(db: Database.Database, destParent: string): Z3ExportData {
  const dir = path.join(destParent, `GoBDesk-Datenexport-${timestamp()}`);
  mkdirSync(dir, { recursive: true });

  let files = 0;
  const descriptions: string[] = [];

  for (const [table, description] of Object.entries(TABLES)) {
    const columns = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string }>
    ).map((c) => `${c.name} (${c.type})`);
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    const header = (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((c) => c.name);
    const csv = toCsv(
      header,
      rows.map((r) => header.map((h) => r[h])),
    );
    writeFileSync(path.join(dir, `${table}.csv`), CSV_BOM + csv, "utf8");
    files += 1;
    descriptions.push(
      `### ${table}.csv\n\n${description}\n\nSpalten: ${columns.join(", ")}\n`,
    );
  }

  writeFileSync(
    path.join(dir, "DATENSATZBESCHREIBUNG.md"),
    CONVENTIONS + descriptions.join("\n"),
    "utf8",
  );
  files += 1;

  // Beschreibungsstandard für den IDEA-Direktimport (index.xml + DTD).
  const supplier =
    ((
      db.prepare("SELECT legal_name AS n FROM company_settings WHERE id = 1").get() as
        | { n: string }
        | undefined
    )?.n || "GoBDesk-Anwender");
  writeFileSync(
    path.join(dir, "index.xml"),
    buildIndexXml(db, supplier, Object.keys(TABLES)),
    "utf8",
  );
  writeFileSync(path.join(dir, "gdpdu-01-08-2002.dtd"), GDPDU_DTD, "utf8");
  files += 2;

  return { path: dir, files };
}
