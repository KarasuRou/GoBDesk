# GoBDesk

**Offline-First-Desktopanwendung für Selbstständige – Kundenverwaltung, rechtssichere E‑Rechnung (ZUGFeRD/Factur‑X) und EÜR in einem schlanken Werkzeug.**

GoBDesk läuft vollständig lokal unter Windows. Es überträgt keine Daten an Dritte,
kommt mit **einer Exe** aus (kein separates Python, Ghostscript oder Java) und legt
den Schwerpunkt auf **GoBD-Konformität**: Belege werden festgeschrieben, gegen
nachträgliche Änderung geschützt und über eine verkettete Prüfsummen-Historie
nachvollziehbar gehalten.

---

## Funktionsumfang

| Bereich | Details |
|---|---|
| **Kundenverwaltung** | Stammdaten, Suche/Filter, Detailansicht mit Kennzahlen (Umsatz, offener Betrag) und verknüpften Belegen |
| **E‑Rechnung (B2B)** | Hybrides **PDF/A‑3 mit eingebettetem ZUGFeRD/Factur‑X‑XML** nach **EN 16931**; Kleinunternehmer- und Regelbesteuerung; Live-Vorschau und EN‑16931-Prüfung |
| **E‑Rechnungs-Empfang** | Erkennt ZUGFeRD/Factur‑X-PDFs und XRechnung-XML (CII **und** UBL) beim DMS-Import und übernimmt Kerndaten als Ausgabe |
| **Aufträge** | Optionale Klammer über Rechnungen, Dokumente und Ausgaben; Auftragsnummer erscheint im PDF, als BT‑14 im XML und ist im Beleg-Hash eingefroren |
| **EÜR** | Einnahmen-Überschuss-Rechnung nach Zufluss-/Abflussprinzip (§ 11 EStG), Zahlungen anteilig je Rate; Auswertung je Jahr inkl. USt/Vorsteuer/Zahllast |
| **DMS** | Paperless-artiges Dokumentenmanagement mit hash-basierter Ablage, Tags, **FTS5-Volltextsuche**, OCR (pypdf/Tesseract), Drag & Drop und Belegverknüpfung |
| **GoBD-Werkzeuge** | Festschreibung, Storno statt Änderung, Audit-Hash-Kette, einsehbares Journal, mehrstufige Selbstprüfung, Z3-Datenüberlassung (IDEA), Verfahrensdokumentations-Generator, geprüfte Sicherungen |

Eine ehrliche Einordnung der GoBD-Grenzen (manipulations-*erkennbar*, nicht
*unmöglich*) steht in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#gobd--ehrliche-grenzen).

## Was GoBDesk besonders macht

Es gibt bereits viele Rechnungs- und Buchhaltungsprogramme. GoBDesk setzt den Schwerpunkt
bewusst **nicht** auf maximalen Funktionsumfang, sondern auf **nachweisbare Integrität,
Datensparsamkeit und ein schlankes, nachvollziehbares Fundament**.

### 1. Ernst gemeinte GoBD-Unveränderbarkeit (verkettete Hash-Kette)

Jeder buchungsrelevante Vorgang (Festschreiben, Storno, Zahlung, Ausgabe, Dokument-Import,
Backup) wird als Glied einer **kryptografisch verketteten Hash-Kette** ins Journal
(`audit_log`) geschrieben: `record_hash = SHA-256(vorheriger_hash | payload)`. Dadurch fällt
**jedes** nachträgliche Einfügen, Löschen oder Umsortieren auf – nicht nur die Änderung eines
einzelnen Datensatzes. Abgesichert durch mehrere, sich ergänzende Mechanismen:

- **Append-Only auf DB-Ebene** – SQLite-Trigger verbieten `UPDATE`/`DELETE` auf `audit_log`,
  festgeschriebene Rechnungen und deren Positionen.
- **Neuberechnung beim Prüfen** – der `content_hash` jeder festgeschriebenen Rechnung wird aus
  den aktuellen Daten neu berechnet und verglichen; erkennt Manipulation **am Trigger vorbei**
  (z. B. direkt in der DB-Datei).
- **Byte-genaue Datei-Integrität** – SHA-256 von PDF, eingebettetem XML und jedem DMS-Dokument
  ist im Journal verankert; eine geänderte Datei bricht den Abgleich.
- **Uhr-Manipulationsschutz** – eine zurückgestellte Systemuhr wird erkannt und blockiert das
  Festschreiben (`assertClockMonotonic`).
- **Nebenaufzeichnungen rekonstruierbar** – Zahlungen und Ausgaben werden aus den
  Journal-Snapshots rekonstruiert und gegen die Tabellen abgeglichen.
- **Korrektur nur per Storno** – festgeschriebene Belege werden nie editiert, sondern durch
  einen referenzierten Storno-/Korrekturbeleg ausgeglichen.

Die mehrstufige **Selbstprüfung** (`verifyGobd`, im Dashboard) fasst all das zu einem Bericht
zusammen. Ehrlich bleibt: GoBD verlangt Manipulations-*Erkennbarkeit*, keine kryptografische
*Unmöglichkeit* – genau das leistet diese Kette (Details und Grenzen in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#gobd--ehrliche-grenzen)).

### 2. Datensparsam by design – kein lauschender Server

Die App ist **Offline-First** und überträgt nichts an Dritte. Der Python-Teil läuft als
**Sidecar über stdin/stdout** – **kein** lokaler HTTP-Server, **kein** offener Netzwerk-Port,
keine Telemetrie. Die Angriffsfläche ist damit kleiner als bei Architekturen mit lokalem
Web-Backend, und die Buchhaltungsdaten verlassen den Rechner nicht.

### 3. Echte E-Rechnung ohne Java

GoBDesk erzeugt **hybride PDF/A-3-Dateien mit eingebettetem EN-16931-XML** (ZUGFeRD/Factur-X),
**veraPDF-validiert als PDF/A-3b** und per XSD + Schematron gegen EN 16931 geprüft – über
`factur-x` / `reportlab` / Ghostscript, **ohne** eine Java-Laufzeit ausliefern zu müssen.
Empfangene ZUGFeRD-/XRechnungs-Belege (CII **und** UBL) werden beim Import ebenfalls erkannt.

### 4. Schlank & selbstbestimmt

Eine **einzige Exe** (Sidecar, Ghostscript und Tesseract gebündelt), **MIT-lizenziert**, ohne
Framework-Ballast im Renderer. Fokus auf Rechnung, EÜR und Dokumentenmanagement – bewusst
keine überladene Komplett-Buchhaltung.

## Tech-Stack

| Schicht | Technologie |
|---|---|
| App-Hülle | **Electron** + **electron-vite** |
| Sprache | **TypeScript** (Renderer als Vanilla-TS, kein UI-Framework) |
| Datenbank | **SQLite** über **better-sqlite3** (WAL, FTS5, Append-Only-Trigger, `STRICT`) |
| Domänen-Kern | TypeScript (`src/core` – Steuer-Engine, GoBD-Festschreibung, Audit-Kette) |
| E‑Rechnung/OCR | **Python-Sidecar**: `factur-x` (XML + Einbettung + Validierung, ohne Java), `reportlab` (PDF), **Ghostscript** (PDF/A‑3), **Tesseract** (OCR) |
| Tests | **Vitest** (Unit) + headless Electron-Smoke (Integration) |

Details zur Schichtung und zum Sidecar-Vertrag: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Projektstruktur

```
GoBDesk/
├─ src/
│  ├─ main/         Electron-Hauptprozess (IPC, DB, Sidecar-Spawn, Speicherort/Backup)
│  ├─ preload/      typisierte IPC-Brücke (window.gobdesk)
│  ├─ renderer/     UI (Vanilla-TS, View-Router)
│  ├─ core/         integritätskritische Domänenlogik (tax.ts, gobd.ts)
│  ├─ db/           Migrations-Runner
│  └─ shared/       geteilte API-Typen
├─ sidecar/         Python-E-Invoice-Sidecar (siehe sidecar/README.md)
├─ db/migrations/   nummerierte SQL-Migrationen (0001–0008)
├─ scripts/         Build-/Bundling-/Smoke-Skripte
├─ test/            Vitest-Unit-Tests
├─ docs/            ARCHITECTURE.md, VERFAHRENSDOKUMENTATION.md
└─ src-tauri/       nur Referenz-Spezifikation (Rust, nicht Teil des Builds)
```

> **Hinweis:** `src-tauri/` stammt aus der ursprünglichen Rust/Tauri-Planung. Die App
> wurde nach Electron + TypeScript portiert; die Rust-Dateien dienen nur noch als
> Referenz-Spezifikation.

## Voraussetzungen (Entwicklung)

- **Node.js** (mit npm)
- **Python 3.11+** – für den Sidecar (Aufruf über `py -3.11`)
- **Ghostscript** – für die PDF/A‑3-Konvertierung (`gswin64c` muss auffindbar sein)
- **Tesseract** *(optional)* – OCR für gescannte Dokumente ohne Textlayer
- **veraPDF** *(optional, nur Dev/CI)* – PDF/A-Konformitätsprüfung

Im **ausgelieferten Paket** sind Sidecar-Binary, Ghostscript und Tesseract enthalten –
der Endanwender benötigt keine dieser Abhängigkeiten.

## Erste Schritte

```bash
# 1. Node-Abhängigkeiten
npm install

# 2. Python-Abhängigkeiten des Sidecars
py -3.11 -m pip install --user -r sidecar/requirements.txt

# 3. App im Entwicklungsmodus starten
npm run dev
```

Details zum Sidecar (Systemabhängigkeiten, JSON-Protokoll, Bündelung) stehen in
[sidecar/README.md](sidecar/README.md).

## npm-Skripte

| Skript | Zweck |
|---|---|
| `npm run dev` | App im Entwicklungsmodus (electron-vite) |
| `npm run build` | Renderer/Main/Preload bauen (`out/`) |
| `npm test` | Vitest-Unit-Tests |
| `npm run typecheck` | TypeScript-Typprüfung (App + Web) |
| `npm run smoke` | Node-Smoke-Test (siehe Hinweis unten) |
| `npm run bundle:sidecar` | Sidecar per PyInstaller zum Binary bündeln |
| `npm run bundle:runtime` | Sidecar + schlanke Ghostscript-Laufzeit stapeln |
| `npm run dist` | Vollständiger Build → Installer/Portable via electron-builder |

> **Hinweis zum Smoke-Test:** `better-sqlite3` wird als Prebuilt für Electrons ABI
> geladen. Solange der Electron-Build aktiv ist, scheitert der Node-`npm run smoke`
> (ABI-Mismatch); die Integration wird stattdessen über den headless Electron-Smoke
> (`GOBDESK_SMOKE=1`) geprüft.

## Build & Auslieferung

```bash
npm run dist
```

Erzeugt aus dem gebauten `out/`, dem gebündelten Sidecar-Binary und der schlanken
Ghostscript-/Tesseract-Laufzeit einen **NSIS-Installer** und eine **Portable-Exe**
(via `electron-builder.yml`). Ein GitHub-Actions-Workflow
([.github/workflows/release.yml](.github/workflows/release.yml)) baut beide Artefakte
auf `windows-latest` und veröffentlicht sie bei einem `v*`-Tag.

## Rechtlicher Rahmen & Haftungsausschluss

GoBDesk ist mit dem Ziel entwickelt, die folgenden Vorgaben zu erfüllen: **GoBD**
(BMF-Schreiben inkl. Änderungen 2024/2025), **EN 16931** / ZUGFeRD / Factur‑X,
§ 14 UStG (Pflichtangaben), § 19 UStG (Kleinunternehmer), § 11 EStG
(Zufluss-/Abflussprinzip) sowie § 147 Abs. 6 AO (Datenüberlassung Z3). Die
technischen Integritätsmechanismen sind in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#gobd-mechanik-unveränderbarkeit--nachvollziehbarkeit)
beschrieben.

> **Ohne Gewähr – keine Steuer- oder Rechtsberatung.** Die Anwendung wurde nach
> bestem Wissen und Gewissen an den genannten Vorgaben ausgerichtet, ist jedoch
> **nicht** durch einen Steuerberater, Wirtschaftsprüfer oder eine amtliche Stelle
> geprüft, zertifiziert oder abgenommen. GoBDesk ersetzt keine steuerliche oder
> rechtliche Beratung. Die Verantwortung für eine korrekte, vollständige und
> rechtskonforme Buchführung – einschließlich einer geeigneten Verfahrens­
> dokumentation und regelmäßiger, unveränderbarer Sicherungen – verbleibt beim
> Anwender. GoBD-Konformität ist technisch **und** organisatorisch; die Software
> unterstützt dabei, garantiert sie aber nicht. Die Nutzung erfolgt auf eigenes
> Risiko. Im Zweifel bitte einen Steuerberater hinzuziehen.

## Dokumentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – Detailarchitektur, GoBD-Mechanik, Sidecar-Vertrag
- [sidecar/README.md](sidecar/README.md) – E‑Invoice-Sidecar
- [docs/VERFAHRENSDOKUMENTATION.md](docs/VERFAHRENSDOKUMENTATION.md) – Verfahrensdokumentations-Vorlage
- [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) – Open-Source-Hinweise der mitgelieferten Fremdkomponenten

## Lizenz

Veröffentlicht unter der **MIT-Lizenz** – siehe [LICENSE](LICENSE). Die Software wird
„wie besehen" ohne jegliche Gewährleistung bereitgestellt (siehe auch den
Haftungsausschluss oben).
Autor: **Rouven Tjalf Rosploch**.

Die mitgelieferten Fremdkomponenten und ihre Lizenzen sind in
[THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) aufgeführt (in der App unter
**Einstellungen → Über GoBDesk → Open-Source-Lizenzen** einsehbar).
