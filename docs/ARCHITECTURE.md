# GoBDesk – Architektur

Offline-First-Desktop-App für Selbstständige: Kundenverwaltung, rechtssichere
E-Rechnung (B2B, EN 16931), EÜR und ein Paperless-artiges Dokumentenmanagement
(DMS). Läuft lokal unter Windows, ohne Datenübertragung an Dritte.

## Schichten

```
Renderer (Vanilla-TypeScript, HTML/CSS im Chromium-Fenster)
    │  contextBridge: window.gobdesk.<methode>()  – typisierte IPC-Brücke
    │  (Preload, src/preload/index.ts)
Electron-Hauptprozess (TypeScript, src/main/*)      ← Prozessgrenze
    • IPC-Handler (ipc.ts)         • DB-Init/Migrationen (db.ts, db/database.ts)
    • Sidecar-Spawn (sidecar.ts)   • Speicherort/Backup (config.ts, storage.ts)
    │
Domänen-Kern (TypeScript, src/core/*)               ← integritätskritisch
    • Steuer-Engine (tax.ts)
    • GoBD-Festschreibung, content_hash, Audit-Hash-Kette, Selbstprüfung (gobd.ts)
    │  Sidecar: ein JSON-Objekt über stdin → ein JSON-Objekt über stdout
Python-Sidecar (sidecar/einvoice/*)                 ← „schmutzige" Arbeit
    • CII-XML (factur-x: generate_cii_xml, EN 16931, XSD + Schematron ohne Java)
    • Basis-PDF (reportlab) → PDF/A-3 (Ghostscript) → XML einbetten (factur-x)
    • EN-16931-Validierung, Text-/OCR-Extraktion (pypdf + Tesseract) fürs DMS
    │
SQLite (better-sqlite3; WAL, FTS5, Append-Only-Trigger)
```

**Warum diese Teilung?** Die revisionssichere Logik (Festschreibung, Hash-Kette,
Selbstprüfung) liegt gebündelt in `src/core` und wird ausschließlich im
Hauptprozess ausgeführt – der Renderer erreicht die DB nur über die schmale,
typisierte IPC-Brücke. Der Python-Sidecar erhält nur bereits festgeschriebene
Daten und liefert PDF/XML bzw. Text zurück – er fasst weder `audit_log` noch
`invoices` direkt an.

> **Hinweis zum Verzeichnis `src-tauri/`.** Die ursprüngliche Planung sah einen
> Rust/Tauri-Kern vor (`src-tauri/src/gobd.rs`, `tax.rs`). Die App wurde nach
> **Electron + TypeScript** portiert; die Rust-Dateien dienen nur noch als
> **Referenz-Spezifikation** und sind nicht Teil des Builds.

## Datenmodell (SQLite, `db/migrations/`)

| Migration | Inhalt |
|---|---|
| `0001_init` | Firmen-/Steuereinstellungen, Kunden, Rechnungen + Positionen, Zahlungen, Ausgaben + EÜR-Kategorien, **Audit-Log**, GoBD-**Trigger**, DMS-Tabellen (documents, tags, links, FTS5) |
| `0002_invoice_artifacts` | Tabelle `invoice_artifacts` (PDF/XML-Pfade, getrennt von der gesperrten Rechnung) |
| `0003_orders` | Aufträge + `order_id` an invoices/documents/expenses (Klammer über Belege) |
| `0004_invoice_buyer_snapshot` | `buyer_name_snapshot` – Käufername zum Festschreibe-Zeitpunkt eingefroren |
| `0005_artifact_hash_and_order_snapshot` | `invoice_artifacts.sha256/byte_size`; `invoices.order_number_snapshot` + `hash_version` |
| `0006_storno` | Storno-Verfahren: `invoices.cancels_invoice_id`, negative Storno-Mengen (`invoice_items`-CHECK), präzisierte Sperr-Trigger (einziger erlaubter Übergang issued → cancelled) |
| `0007_einvoice_inbound` | `documents.einvoice_json` – gecachte Kerndaten empfangener E-Rechnungen (ZUGFeRD/XRechnung, CII + UBL) |
| `0008_address_snapshot_verfdok` | `invoices.buyer_address_snapshot` (Rechnungsanschrift eingefroren, Teil des Hash v4) + Trigger-Neubau; Tabelle `verfdok_texts` (organisatorische Angaben für den Verfahrensdok-Generator) |

Kernkonventionen: **Geld = Integer-Cent, Steuersatz = Basispunkte (1900 = 19 %),
Menge = Milli**; Datums-/Zeitwerte als ISO-8601-Text. `STRICT`-Tabellen erzwingen
die Typdisziplin.

## GoBD-Mechanik (Unveränderbarkeit + Nachvollziehbarkeit)

- **Festschreibung (`gobd.ts::issueInvoice`)**, atomar in einer Transaktion:
  Nummernvergabe (lückenlos, `number_sequences`), Betragsberechnung (`tax.ts`),
  Einfrieren der Positionssummen, Bildung des **`content_hash`** und Anhängen des
  Audit-Eintrags.
- **Snapshots zum Festschreibe-Zeitpunkt** (spätere Änderungen an Stammdaten
  verändern Altbelege nicht): `is_kleinunternehmer_snapshot`, `buyer_name_snapshot`,
  `buyer_address_snapshot` (Rz. 76: Mehrstück bleibt auch aus den Tabellendaten
  reproduzierbar), `order_number_snapshot`.
- **`content_hash`** = SHA-256 einer kanonischen Serialisierung (`invoiceContentHash`)
  aus Nummer, Datum, Kunde/Käufername, Netto/USt/Brutto, Steuermodus,
  Auftragsnummer, Storno-Referenz **und Käuferanschrift**. `hash_version`
  markiert das Format (1 = Basis, 2 = + Auftragsnummer, 3 = + Storno-Referenz,
  4 = + Käuferanschrift) und hält Altbelege ohne Falsch-Alarm prüfbar.
- **Sperr-Trigger:** UPDATE/DELETE auf festgeschriebenen und stornierten Rechnungen
  und deren Positionen sowie jedes UPDATE/DELETE auf `audit_log` werden per Trigger
  abgewiesen. Der einzige erlaubte Übergang ist issued → cancelled, bei dem
  ausschließlich `status`/`cancelled_by_invoice_id`/`updated_at` geändert werden.
- **Storno (`gobd.ts::cancelInvoice`):** Korrektur ausschließlich per eigenem,
  festgeschriebenem **Stornobeleg** (identische Positionen mit negierter Menge —
  EN 16931 BR-27 verbietet nur negative Preise). Rückbeziehbar über
  `cancels_invoice_id` (DB), `CANCEL`-Journaleintrag (mit Grund) und **BT-25**
  im XML; die Storno-Nummer ist Teil des content_hash (v3).
- **Audit-Hash-Kette** (`audit_log`, append-only): jeder Eintrag verkettet über
  `prev_hash` den Vorgänger (`record_hash = SHA-256(prev_hash | payload)`).
  Nachträgliches Ändern/Löschen/Umsortieren bricht die Kette.
- **Datei-Integrität:** Beim Festschreiben werden PDF und XML per **SHA-256**
  gehasht (`invoice_artifacts.sha256`) und die Soll-Hashes zusätzlich als
  `ARTIFACTS`-Journaleintrag in der Hash-Kette **verankert** (manipulationssicher).

### GoBD-Selbstprüfung (`gobd.ts::verifyGobd`, Dashboard → „GoBD-Prüfung starten")

Sieben unabhängige Prüfungen, als strukturierter Bericht dargestellt:

1. **Journal-Hash-Kette** – lückenlose Verkettung (+ Anzahl/Zeitspanne).
2. **Beleg-Prüfsummen** – `content_hash` jeder festgeschriebenen/stornierten
   Rechnung aus den aktuellen Daten neu berechnet und verglichen (erkennt
   Manipulation der eingefrorenen Rechnung, auch am Trigger vorbei).
3. **Rechnungsdateien** – PDF/XML byte-genau gegen den (journal-verankerten)
   Soll-SHA-256 geprüft; trennt Datenverlust (Datei fehlt), Manipulation
   (Hash weicht ab) und „noch kein PDF erzeugt".
4. **Schreibschutz-Trigger** – Vorhandensein der GoBD-Sperr-Trigger im Schema.
5. **Nebenaufzeichnungen** – Zahlungen und Ausgaben gegen die manipulationssicheren
   Journal-Snapshots abgeglichen (erkennt INSERT/UPDATE/DELETE an der App vorbei;
   dafür journalisieren `addPayment`/`createExpense`/`updateExpense` vollständige
   Snapshots inkl. Vorzustand).
6. **DMS-Dokumente** – jede abgelegte Datei byte-genau gegen die beim (journalisierten)
   Import gespeicherte `content_sha256` geprüft.
7. **Zeitgerechtheit** (Hinweis) – offene Rechnungsentwürfe, insbesondere älter
   als 30 Tage (Rz. 45 ff.); fließt nicht in das Gesamtergebnis ein.

### Dokumentenschutz (DMS)

Als Beleg verknüpfte Dokumente (Kunde/Auftrag/Rechnung/Ausgabe) sind **nicht
löschbar**, nur archivierbar (`is_archived`); Import, Metadaten-Änderung,
OCR-Korrektur, Archivierung und Löschung (nur unverknüpft) werden journalisiert.

### Datenzugriff (Z3)

`export.ts::exportZ3` erzeugt für die Datenüberlassung (§ 147 Abs. 6 AO)
einen CSV-Gesamtexport aller steuerrelevanten Tabellen plus
`DATENSATZBESCHREIBUNG.md` (Konventionen, Tabellen- und Spaltenbeschreibung —
Strukturinformationen nach Rz. 176) sowie `index.xml` + `gdpdu-01-08-2002.dtd`
(Beschreibungsstandard mit Spaltentypen und Primär-/Fremdschlüsseln für den
**IDEA-Direktimport** der Prüfsoftware).

### Weitere Schutz- und Komfortmechanismen

- **Uhr-Manipulationsschutz:** Journaleinträge blockieren, wenn die Systemzeit
  deutlich (> 5 min) vor dem letzten Eintrag liegt (`assertClockMonotonic`);
  rückläufige Zeitstempel im Bestand meldet die Prüfung (`auditChain.nonMonotonic`).
- **Start-Selbstprüfung:** `quickCheckGobd` (Kette + Beleg-Prüfsummen, ohne
  Datei-IO) läuft beim Dashboard-Aufruf; Befunde erscheinen als Warnbanner.
- **IKS-Backup-Erinnerung + Nachweis:** Zeitpunkt der letzten Sicherung wird in
  der App-Konfiguration geführt (> 7 Tage → Dashboard-Hinweis); zusätzlich wird
  jede Sicherung als `backup/CREATE`-Eintrag (Ziel, DB-SHA-256, Ketten-Prüfergebnis)
  in der Hash-Kette verankert.
- **DMS-Kopie-Verifikation:** Import verifiziert die abgelegte Kopie byte-genau
  gegen den Quell-Hash, bevor der Datensatz entsteht.
- **E-Rechnungs-Empfang:** Sidecar-Command `einvoice` (`inbound.py`) erkennt
  ZUGFeRD/Factur-X-PDFs und XRechnung-XML (CII **und** UBL, namespace-agnostisch)
  und extrahiert Kerndaten; das Dokument-Detail bietet „Als Ausgabe übernehmen"
  mit automatischer Belegverknüpfung. Das Original bleibt unverändert (Rz. 131).
- **Verfahrensdok-Generator:** `verfdok.ts` erzeugt eine aus Systemdaten
  vorausgefüllte Verfahrensdokumentation (4 BMF-Teilbereiche) als **PDF**
  (`renderVerfdokHtml` + `printToPDF`) oder Markdown. Organisatorische Angaben
  erfasst der Anwender in einem Formular (Einstellungen); sie werden in
  `verfdok_texts` gespeichert und direkt in das Dokument eingesetzt. Jeder
  Export wird mit SHA-256 als `verfdok/EXPORT` in der Hash-Kette verankert
  (Versionierungsnachweis).

### Einsehbares Journal (`gobd.ts::listJournal`, Nav → „Journal")

Der `audit_log` ist zusätzlich als **menschenlesbarer, chronologischer Nachweis**
einsehbar (Zeitpunkt, Vorgang in Klartext, Beleg, sichtbare Hash-Verkettung je
Eintrag) und als **CSV/JSON exportierbar** – so ist die lückenlose Nachverfolgung für
einen sachverständigen Dritten direkt sichtbar. Protokolliert werden Festschreibung
(`ISSUE`), Datei-Erzeugung (`ARTIFACTS`), Storno (`CANCEL`), Zahlungseingänge/-stornos
(`payment ADD/DELETE`), Ausgaben (`expense CREATE/UPDATE`), DMS-Vorgänge
(`document IMPORT/UPDATE/OCR/ARCHIVE/DELETE`), Sicherungen (`backup CREATE`) und
Verfahrensdok-Exporte (`verfdok EXPORT`). Die Rechnungs-Detailansicht zeigt die
belegbezogene Historie (`listJournalForInvoice`).

## Ablauf „Rechnung festschreiben & E-Rechnung erzeugen"

1. Renderer ruft `window.gobdesk.issueInvoice(id)` → IPC → `issueInvoiceWithPdf`.
2. `gobd.ts::issueInvoice` prüft, berechnet, vergibt die Nummer, friert
   Käufer-/Auftragsnummer ein, bildet den `content_hash`, hängt den Audit-Eintrag
   an – alles in einer Transaktion. Ab jetzt sperren die Trigger.
3. Der Hauptprozess baut die Sidecar-Anfrage (`buildSidecarRequest`, inkl. der
   eingefrorenen Auftragsnummer) und ruft den Command `render`.
4. Der Sidecar erzeugt das hybride **PDF/A-3 + eingebettetes XML**, validiert gegen
   EN 16931 und meldet die Pfade zurück.
5. Der Hauptprozess speichert die Pfade **und die SHA-256/Größe** in
   `invoice_artifacts` und verankert die Datei-Hashes als `ARTIFACTS`-Journaleintrag.

## Sidecar-Vertrag (JSON über stdin/stdout)

Request (Hauptprozess → Python), Command `render`:

```json
{
  "command": "render",
  "profile": "en16931",
  "output_dir": "…/invoices",
  "invoice": {
    "number": "2026-0007",
    "issue_date": "2026-07-08",
    "service_date": "2026-06-30",
    "due_date": "2026-07-22",
    "currency": "EUR",
    "is_kleinunternehmer": false,
    "seller": { "…": "aus company_settings" },
    "buyer":  { "…": "aus customers" },
    "lines":  [ { "description": "Beratung", "quantity_milli": 2000,
                  "unit": "HUR", "unit_price_net_cents": 9000, "tax_rate_bp": 1900 } ],
    "payment_terms": "Zahlbar innerhalb von 14 Tagen.",
    "order_number": "2026-A0001",
    "cancels_number": null
  }
}
```

Bei Stornorechnungen trägt `cancels_number` die Nummer des stornierten Originals –
sie erscheint als **BT-25** im XML und als „Storno zu Rechnung" im PDF
(Dokumenttitel „Stornorechnung").

Response (Python → Hauptprozess):

```json
{ "ok": true, "pdf_path": "…/2026-0007.pdf", "xml_path": "…/2026-0007.xml" }
```

Weitere Commands: `preview` (schnelles Basis-PDF ohne Festschreibung, mit
„ENTWURF"-Wasserzeichen), `validate` (nur EN-16931-Prüfung einer bestehenden
PDF/XML), `extract` (Text-/OCR-Extraktion für die DMS-Volltextsuche).

## Eingesetzte Bibliotheken

- **CII-XML + Einbettung:** `factur-x` (`generate_cii_xml`, Profil `en16931`;
  XSD + Schematron eingebaut – **kein Java** nötig).
- **Basis-PDF:** `reportlab` (reines Python, PyInstaller-freundlich).
- **PDF/A-3-Konvertierung:** **Ghostscript** (im Paket mitgeliefert).
- **PDF-Handling/Text:** `pypdf`, `lxml`.
- **OCR:** **Tesseract** (für gescannte Dokumente ohne Textlayer).
- **PDF/A-Konformitätsprüfung:** `veraPDF` – reines **Dev-/CI-Werkzeug**, nicht ausgeliefert.

## Auslieferung (Single-Exe)

Der Endanwender installiert **eine Exe** – kein separates Python, Ghostscript oder
Java. Der Sidecar wird per **PyInstaller** zum Binary gebündelt, Ghostscript und
Tesseract werden als schlanke Laufzeit mitgeliefert. Im Paket-Modus setzt der
Hauptprozess `GOBDESK_SIDECAR_BIN`, `GOBDESK_GS`/`GOBDESK_GS_ICC`,
`GOBDESK_TESSERACT`/`TESSDATA_PREFIX` (siehe `src/main/runtime.ts`). Ohne diese
Variablen (Entwicklung) läuft alles über `py -3.11 -m einvoice` und System-Tools.

## Fachliche Kernentscheidungen

- **Geld = Integer-Cent, Steuersatz = Basispunkte, Menge = Milli.** Keine Floats.
- **USt je Steuersatz auf die Netto-Summe** (EN 16931), nicht je Zeile.
- **Steuermodus bei Festschreibung eingefroren** – späteres Umschalten des globalen
  Kleinunternehmer-Flags verändert Altbelege nicht.
- **EÜR = Zufluss-/Abflussprinzip (§11 EStG):** Einnahmen bei Zahlungseingang
  (`payments.paid_at`, **anteilig je Rate** `paid/gross`), Ausgaben bei Zahlung.
- **Kleinunternehmer:** 0 % + §19-Hinweis, Ausgaben brutto. Regelbesteuerung: USt je
  Satz getrennt ausgewiesen.
- **Korrektur statt Änderung:** festgeschriebene Rechnung nie editieren, sondern
  Storno-/Korrekturbeleg.
- **Aufträge** als optionale Klammer über Rechnungen/Dokumente/Ausgaben; die
  Auftragsnummer erscheint im PDF-Kopf, als **BT-14** im XML und ist im
  `content_hash` eingefroren.

## GoBD – ehrliche Grenzen

Die App macht Manipulation **erkennbar** (Append-Only-Trigger, verkettete SHA-256,
byte-genaue Datei-Hashes), nicht technisch **unmöglich** – die SQLite-Datei gehört
dem Nutzer. GoBD-Konformität auf einem lokalen System ist immer technisch **und**
organisatorisch: dazu gehören eine **Verfahrensdokumentation** und regelmäßige,
unveränderbare Sicherungen (schreibgeschützter Snapshot inkl. Manifest, siehe
`storage.ts`). `verifyGobd` liefert die technische Integritätsprüfung dafür.
