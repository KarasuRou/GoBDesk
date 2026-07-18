/**
 * Generator für die Verfahrensdokumentation (GoBD Rz. 151 ff.): erzeugt aus den
 * echten Systemdaten (Firma, Pfade, Versionsstand, Kennzahlen, Prüfergebnis)
 * und den vom Anwender hinterlegten organisatorischen Angaben (verfdok_texts)
 * ein Markdown-Dokument in den vier vom BMF vorgesehenen Teilbereichen.
 * Fehlende Angaben bleiben als gekennzeichnete Platzhalter stehen. Für den
 * PDF-Export liefert renderVerfdokHtml eine druckfertige HTML-Fassung.
 */

import path from "node:path";

import { app } from "electron";
import type Database from "better-sqlite3";

import { quickCheckGobd } from "../core/gobd.js";
import { VERFDOK_FIELDS } from "../shared/api.js";
import { getDataDir, getLastBackupAt } from "./config.js";
import { DB_FILENAME } from "./storage.js";

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

const FIELD_KEYS = new Set(VERFDOK_FIELDS.map((f) => f.key));

/** Gespeicherte organisatorische Angaben (nur bekannte Feld-Schlüssel). */
export function getVerfdokTexts(db: Database.Database): Record<string, string> {
  const rows = db.prepare("SELECT key, value FROM verfdok_texts").all() as Array<{
    key: string;
    value: string;
  }>;
  const out: Record<string, string> = {};
  for (const r of rows) if (FIELD_KEYS.has(r.key)) out[r.key] = r.value;
  return out;
}

/** Speichert die Angaben für den nächsten Export (leere Felder werden entfernt). */
export function saveVerfdokTexts(db: Database.Database, texts: Record<string, string>): void {
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO verfdok_texts (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const del = db.prepare("DELETE FROM verfdok_texts WHERE key = ?");
  const run = db.transaction(() => {
    for (const key of FIELD_KEYS) {
      const value = typeof texts[key] === "string" ? texts[key].trim() : "";
      if (value) upsert.run(key, value, now);
      else del.run(key);
    }
  });
  run();
}

export function generateVerfahrensdok(
  db: Database.Database,
  texts: Record<string, string> = getVerfdokTexts(db),
): string {
  const company = db
    .prepare(
      "SELECT legal_name, address_line1, zip, city, tax_number, vat_id, is_kleinunternehmer FROM company_settings WHERE id = 1",
    )
    .get() as
    | {
        legal_name: string;
        address_line1: string;
        zip: string;
        city: string;
        tax_number: string | null;
        vat_id: string | null;
        is_kleinunternehmer: number;
      }
    | undefined;

  const userVersion = (db.pragma("user_version", { simple: true }) as number) ?? 0;
  const quick = quickCheckGobd(db);
  const lastBackup = getLastBackupAt();
  const today = new Date().toISOString().slice(0, 10);
  const name = company?.legal_name || "<Firmenname eintragen>";
  // Hinterlegte Angabe des Anwenders oder gekennzeichneter Platzhalter.
  const filled = (key: string): string => {
    const value = texts[key]?.trim();
    if (value) return value;
    const hint = VERFDOK_FIELDS.find((f) => f.key === key)?.hint ?? key;
    return `> ✏️ **Vom Anwender zu ergänzen:** ${hint}`;
  };

  return `# Verfahrensdokumentation – ${name}

> Automatisch erzeugt von GoBDesk am ${today}. Systemdaten und die in der
> Anwendung hinterlegten organisatorischen Angaben sind eingesetzt; mit ✏️
> markierte Abschnitte sind noch zu ergänzen. Die unterschriebene, versionierte
> Fassung ist aufzubewahren (Aufbewahrungsfrist wie die Unterlagen, zu deren
> Verständnis sie dient). Kein Ersatz für steuerliche Beratung.

| Feld | Wert |
|---|---|
| Unternehmen | ${name} |
| Anschrift | ${company ? `${company.address_line1}, ${company.zip} ${company.city}` : "<eintragen>"} |
| Steuernummer | ${company?.tax_number ?? "<eintragen>"} |
| USt-IdNr | ${company?.vat_id ?? "—"} |
| Besteuerung | ${company?.is_kleinunternehmer === 1 ? "Kleinunternehmer (§ 19 UStG)" : "Regelbesteuerung"} |
| Software | GoBDesk ${app.getVersion()} |
| Datenbank-Schemastand | Migration ${userVersion} |
| Stand dieser Dokumentation | ${today} |

## 1. Allgemeine Beschreibung

${name} setzt die lokal installierte Desktop-Anwendung **GoBDesk** für
Kundenverwaltung, elektronische Ausgangsrechnungen (ZUGFeRD/Factur-X, EN 16931,
PDF/A-3), Einnahmen-Überschuss-Rechnung (§ 4 Abs. 3 EStG, Zufluss-/Abflussprinzip
§ 11 EStG) und die Aufbewahrung elektronischer Belege (integriertes DMS) ein.
Die Verarbeitung erfolgt vollständig lokal; es findet keine Übertragung an
Dritte statt.

Aktueller Datenbestand: ${count(db, "invoices")} Rechnungen,
${count(db, "expenses")} Ausgaben, ${count(db, "payments")} Zahlungen,
${count(db, "documents")} Dokumente, ${count(db, "audit_log")} Journaleinträge.

${filled("business")}

## 2. Anwenderdokumentation

Die Bedienabläufe sind in der Anwendung selbst geführt; die Kernprozesse:

1. Kunden und (optional) Aufträge anlegen.
2. Rechnungen als Entwurf erfassen, prüfen (Vorschau) und **festschreiben** –
   dabei entstehen Rechnungsnummer (lückenlos), Prüfsumme, ZUGFeRD-PDF/A-3 + XML.
3. Zahlungen (auch Teilbeträge/Rückzahlungen) je Rechnung erfassen.
4. Korrekturen ausschließlich per **Storno** (festgeschriebener Gegenbeleg).
5. Ausgaben mit EÜR-Kategorie erfassen; Belege im DMS ablegen und verknüpfen.
6. Integrität prüfen (GoBD-Prüfung), Journal einsehen/exportieren, Sicherungen erstellen.

${filled("erfassung")}

## 3. Technische Systemdokumentation

- **Anwendung:** GoBDesk ${app.getVersion()} (Electron/TypeScript), Windows, lokal.
- **Datenbank:** SQLite (\`${path.join(getDataDir(), DB_FILENAME)}\`), WAL-Modus,
  Fremdschlüssel aktiv, Schemastand Migration ${userVersion}.
- **Datenspeicherort:** \`${getDataDir()}\` (Rechnungs-Artefakte unter \`invoices\\\`,
  Dokumente unter \`documents\\\`).
- **Unveränderbarkeit:** Festschreibung mit Sperr-Triggern (UPDATE/DELETE
  blockiert; einziger erlaubter Übergang: Storno-Kennzeichnung), Snapshots
  (Steuermodus, Käufername und -anschrift, Auftragsnummer), Beleg-Prüfsumme
  (SHA-256, versioniert), append-only-Journal mit SHA-256-Hash-Kette,
  byte-genaue Datei-Prüfsummen (PDF/XML/DMS) mit Journal-Verankerung, Schutz
  gegen zurückgestellte Systemuhr (Monotonie-Prüfung).
- **E-Rechnung:** integrierter Sidecar (EN 16931, XSD + Schematron, PDF/A-3b via
  Ghostscript, OCR via Tesseract) – Laufzeiten im Paket gebündelt.
- **Selbstprüfung:** automatischer Integritäts-Check beim Start; vollständige
  GoBD-Prüfung (7 Prüfbereiche) auf Abruf. Letztes Ergebnis:
  ${quick.ok ? "**bestanden**" : `**Problem erkannt** (Kette: ${quick.chainOk ? "ok" : `gebrochen bei #${quick.brokenAtId}`}, abweichende Belege: ${quick.tampered})`}${quick.nonMonotonic > 0 ? `, ${quick.nonMonotonic} Zeitstempel-Auffälligkeit(en)` : ""}.
- **Datenzugriff (Z3):** CSV-Gesamtexport inkl. \`index.xml\`
  (Beschreibungsstandard) und Datensatzbeschreibung.

## 4. Betriebsdokumentation (IKS und Datensicherung)

- **Sicherung:** schreibgeschützter Snapshot (DB + Artefakte + Manifest mit
  SHA-256 und Ketten-Prüfergebnis) über Einstellungen → Daten & Sicherung;
  jede Sicherung wird im revisionssicheren Journal protokolliert.
  Letzte Sicherung: ${lastBackup ? lastBackup.slice(0, 10) : "**noch keine**"}.
  Die Anwendung erinnert, wenn die letzte Sicherung älter als 7 Tage ist.
- **Aufbewahrungsfristen:** Bücher/Aufzeichnungen/Journal 10 Jahre;
  Buchungsbelege (Rechnungen) 8 Jahre (§ 147 Abs. 3 AO i. d. F. BEG IV, ab 2025);
  Handels-/Geschäftsbriefe 6 Jahre. Die Software löscht selbst nichts.
- **Zugriffsschutz und Datensicherungsorganisation:**

${filled("sicherheit")}

## 5. Änderungshistorie dieser Dokumentation

| Version | Datum | Erstellt | Änderung |
|---|---|---|---|
| 1.0 | ${today} | GoBDesk ${app.getVersion()} (automatisch) | Erstfassung aus Systemdaten |
`;
}

// ---------------------------------------------------------------------------
// HTML-Rendering für den PDF-Export (deckt exakt die oben erzeugten
// Markdown-Konstrukte ab: Überschriften, Tabellen, Zitate, Listen, Absätze).
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inline(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

const VERFDOK_PRINT_CSS = `
  body { font: 11pt/1.5 "Segoe UI", system-ui, sans-serif; color: #1a1d21; margin: 0; }
  h1 { font-size: 17pt; margin: 0 0 10pt; border-bottom: 2px solid #1a1d21; padding-bottom: 6pt; }
  h2 { font-size: 13pt; margin: 16pt 0 6pt; }
  p { margin: 0 0 7pt; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 10pt; }
  th, td { border: 1px solid #b6bcc4; padding: 3pt 6pt; text-align: left; vertical-align: top; }
  th { background: #eef1f4; }
  blockquote { margin: 0 0 8pt; padding: 5pt 8pt; border-left: 3px solid #8a919b; background: #f4f6f8; }
  blockquote p { margin: 0; }
  ul, ol { margin: 0 0 8pt; padding-left: 18pt; }
  li { margin-bottom: 3pt; }
  code { font-family: Consolas, monospace; font-size: 9.5pt; background: #f0f2f5; padding: 0 2pt; }
  h1, h2, table, blockquote { page-break-inside: avoid; }
`;

/** Wandelt das erzeugte Verfahrensdok-Markdown in ein druckfertiges HTML-Dokument. */
export function renderVerfdokHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;

  const isTableLine = (l: string): boolean => l.trimStart().startsWith("|");
  const listItem = /^(\d+)\.\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
    } else if (trimmed.startsWith("# ")) {
      out.push(`<h1>${inline(trimmed.slice(2))}</h1>`);
      i += 1;
    } else if (trimmed.startsWith("## ")) {
      out.push(`<h2>${inline(trimmed.slice(3))}</h2>`);
      i += 1;
    } else if (trimmed.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quote.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
    } else if (isTableLine(trimmed)) {
      const rows: string[][] = [];
      while (i < lines.length && isTableLine(lines[i].trim())) {
        const cells = lines[i].trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
        rows.push(cells.map((c) => c.trim()));
        i += 1;
      }
      const [header, ...body] = rows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
      out.push("<table>");
      out.push(`<tr>${header.map((c) => `<th>${inline(c)}</th>`).join("")}</tr>`);
      for (const r of body) out.push(`<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`);
      out.push("</table>");
    } else if (trimmed.startsWith("- ") || listItem.test(trimmed)) {
      const ordered = listItem.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const t = l.trim();
        if (ordered ? listItem.test(t) : t.startsWith("- ")) {
          items.push(ordered ? t.replace(listItem, "$2") : t.slice(2));
          i += 1;
        } else if (/^\s+\S/.test(l) && items.length > 0) {
          items[items.length - 1] += ` ${t}`; // eingerückte Fortsetzungszeile
          i += 1;
        } else {
          break;
        }
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`);
    } else {
      const para: string[] = [trimmed];
      i += 1;
      while (i < lines.length && lines[i].trim() && !/^([#>|-]|\d+\.\s)/.test(lines[i].trim())) {
        para.push(lines[i].trim());
        i += 1;
      }
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }

  return `<!doctype html><html lang="de"><head><meta charset="utf-8">
<title>Verfahrensdokumentation</title><style>${VERFDOK_PRINT_CSS}</style>
</head><body>${out.join("\n")}</body></html>`;
}
