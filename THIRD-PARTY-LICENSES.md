# Open-Source-Hinweise (Third-Party Licenses)

GoBDesk selbst steht unter der **MIT-Lizenz** (siehe [LICENSE](LICENSE)). Die
ausgelieferte Anwendung enthält bzw. bündelt zusätzlich die folgenden
Fremdkomponenten. Ihre jeweiligen Copyright- und Lizenzhinweise werden hiermit
gemäß den Lizenzbedingungen weitergegeben. Die vollständigen, verbindlichen
Lizenztexte liegen im jeweiligen Paket bei und sind unter den angegebenen Links
abrufbar.

> **Hinweis zur Vollständigkeit:** Diese Liste erfasst die *mitgelieferten*
> Laufzeitkomponenten. Reine Entwicklungs-/Build-Werkzeuge (TypeScript, Vite,
> electron-builder, Vitest, PyInstaller, veraPDF u. a.) werden **nicht**
> ausgeliefert und lösen keine Nennungspflicht aus. Eine vollständige, auch
> transitive Aufstellung lässt sich mit `license-checker` (npm) und
> `pip-licenses` (Python) automatisch erzeugen.

---

## Anwendungslaufzeit (Electron / Node)

### Electron — MIT
© GitHub Inc. und die Electron-Contributors.
Enthält seinerseits **Chromium** (BSD-3-Clause, © The Chromium Authors) und
**Node.js** (MIT und weitere permissive Lizenzen).
https://github.com/electron/electron

### better-sqlite3 — MIT
© Joshua Wise. Bindet **SQLite** ein, das **gemeinfrei (Public Domain)** ist.
https://github.com/WiseLibs/better-sqlite3 · https://www.sqlite.org/copyright.html

---

## E-Rechnungs-/PDF-Sidecar (Python, gebündelt via PyInstaller)

### factur-x — BSD
© Alexis de Lattre / Akretion. Erzeugt das EN-16931-CII-XML, bettet es in
PDF/A-3 ein und validiert es (XSD + Schematron).
https://github.com/akretion/factur-x

### reportlab — BSD-3-Clause
© ReportLab Europe Ltd. Erzeugung des Basis-PDFs.
https://www.reportlab.com/

### pypdf — BSD-3-Clause
© Mathieu Fenniak und die pypdf-Contributors. PDF-Verarbeitung / Textextraktion.
https://github.com/py-pdf/pypdf

### lxml — BSD-3-Clause
© Infrae und die lxml-Contributors. XML-Verarbeitung.
https://lxml.de/

### Tesseract OCR — Apache-2.0
© Google Inc. und die Tesseract-Contributors. OCR gescannter Dokumente.
Die Apache-2.0-Lizenz sowie ggf. mitgeführte `NOTICE`-Angaben liegen dem
gebündelten Tesseract bei.
https://github.com/tesseract-ocr/tesseract

### Ghostscript — GNU AGPL v3  ⚠️
© Artifex Software, Inc. Konvertierung nach PDF/A-3.
**Ghostscript ist unter der AGPL v3 lizenziert (alternativ kommerziell von
Artifex).** GoBDesk ruft Ghostscript ausschließlich als **eigenständiges
Programm** (separater Prozess) auf und linkt es nicht ein; die eigene MIT-Lizenz
von GoBDesk bleibt davon unberührt. Für die *mitgelieferte* Ghostscript-Kopie
gelten die AGPL-Bedingungen: Lizenztext und Quellcode sind verfügbar unter
https://www.ghostscript.com/ bzw. https://git.ghostscript.com/.
Der vollständige AGPL-v3-Text: https://www.gnu.org/licenses/agpl-3.0.html

---

## Schriften

### DejaVu Sans — DejaVu-Fonts-Lizenz (Bitstream-Vera-basiert, permissiv)
© Bitstream, Inc. (Bitstream Vera) und © Tavmjong Bah (DejaVu-Ergänzungen).
In die erzeugten PDF-Dokumente eingebettet. Die Schriften dürfen frei verwendet
und weitergegeben, aber nicht als eigenständiges Schrift-Produkt verkauft werden.
https://dejavu-fonts.github.io/
