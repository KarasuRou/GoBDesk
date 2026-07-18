# GoBDesk – E-Invoice-Sidecar

Python-Sidecar, der Rechnungsdaten (JSON) in ein hybrides **PDF/A-3** mit
eingebettetem **ZUGFeRD/Factur-X-XML (EN 16931)** verwandelt. Kommuniziert per
JSON über stdin/stdout und wird später aus der Electron-App heraus aufgerufen.

## Systemabhängigkeiten
- Python 3.11+ *(nur Entwicklung; im ausgelieferten Paket steckt ein
  eigenständiges Binary, siehe „Bündelung")*
- **Ghostscript** (für die PDF/A-3-Konvertierung) — `gswin64c` muss auffindbar sein.
  Im Paket wird eine schlanke Ghostscript-Laufzeit mitgeliefert; die App zeigt dem
  Sidecar den Pfad über `GOBDESK_GS` / `GOBDESK_GS_ICC`.
- **Tesseract** (OCR für gescannte Dokumente ohne Textlayer, Command `extract`) —
  im Paket mitgeliefert, Pfad über `GOBDESK_TESSERACT` / `TESSDATA_PREFIX`.
- optional, nur Entwicklung: veraPDF für die PDF/A-Konformitätsprüfung

## Installation
    py -3.11 -m pip install --user -r requirements.txt

## Nutzung
    py -3.11 -m einvoice < request.json > result.json

Windows/PowerShell-Hinweis: stdin-Umleitung zuverlässig über
`cmd /c "py -3.11 -m einvoice < request.json"` (PowerShell-Pipes können die
Kodierung verfälschen). PYTHONPATH auf den `sidecar`-Ordner setzen.

Commands: `render` (PDF/A-3 + XML festschreiben), `preview` (schnelles Basis-PDF mit
„ENTWURF"-Wasserzeichen), `validate` (EN-16931-Prüfung einer bestehenden Datei),
`extract` (Text-/OCR-Extraktion fürs DMS). Eine zugeordnete Auftragsnummer wird als
`invoice.order_number` übergeben und landet als **BT-14** im XML sowie im PDF-Kopf.

Request-Format siehe `samples/`. Antwort bei Erfolg (render):

    { "ok": true, "pdf_path": "...", "xml_path": "..." }

## Bündelung (Single-Exe, Phase 8)
Für die Auslieferung wird der Sidecar per **PyInstaller** in ein eigenständiges
Binary gepackt – der Endanwender braucht kein installiertes Python:

    npm run bundle:sidecar     # -> sidecar/dist/einvoice/einvoice.exe (+ _internal/)
    npm run bundle:runtime     # stapelt Sidecar + schlanke Ghostscript-Laufzeit nach build/bundle/
    npm run dist               # baut out/, bündelt, erzeugt den Installer via electron-builder

Das Binary verhält sich wie `einvoice`: JSON über stdin, Ergebnis über stdout. Im
Paket-Modus setzt der Electron-Hauptprozess `GOBDESK_SIDECAR_BIN` auf das Binary und
`GOBDESK_GS`/`GOBDESK_GS_ICC` auf das mitgelieferte Ghostscript (siehe
`src/main/runtime.ts`). Ohne diese Variablen (Entwicklung) läuft alles wie gehabt
über `py -3.11` und das System-Ghostscript.

## Pipeline
JSON → EN-16931-Mapping (`xml_builder`) → CII-XML (`facturx.generate_cii_xml`,
XSD + Schematron) → Basis-PDF (`pdf_builder`, reportlab) → PDF/A-3
(`pdfa.to_pdfa3`, Ghostscript) → XML einbetten (`pdfa.embed_xml`, factur-x).

## Status
- XML Regel- **und** Kleinunternehmer-Fall: XSD + Schematron valide (ohne Java)
- Hybrides PDF erzeugt, `factur-x.xml` eingebettet & extrahierbar (level=en16931)
- PDF/A-3-Konformität extern mit veraPDF bestätigt
- In der App integriert (Festschreiben, Vorschau, Validierung, OCR)

## Module
- `einvoice/model.py` – Eingangsmodell + Betragsberechnung (Cent/bp/milli)
- `einvoice/xml_builder.py` – EN-16931-CII-XML aus Business-Terms (inkl. BT-14)
- `einvoice/pdf_builder.py` – Basis-PDF (reportlab)
- `einvoice/pdfa.py` – Ghostscript-PDF/A-3 + factur-x-Einbettung
- `einvoice/render.py` – Orchestrierung der Pipeline (render/preview)
- `einvoice/validate.py` – EN-16931-Prüfung bestehender PDF/XML
- `einvoice/extract.py` – Text-/OCR-Extraktion (pypdf + Tesseract) fürs DMS
- `einvoice/__main__.py` – stdin/stdout-Schnittstelle (Command-Dispatch)
- `probe.py`, `verify.py` – Wegwerf-Entwicklungshilfen (nicht Teil des Sidecars)
