# Verfahrensdokumentation – GoBDesk

> **Vorlage.** Diese Datei ist ein Muster nach den **GoBD** (Grundsätze zur
> ordnungsmäßigen Führung und Aufbewahrung von Büchern, Aufzeichnungen und
> Unterlagen in elektronischer Form). Ersetze alle `<Platzhalter>` durch deine
> Angaben und bewahre eine unterschriebene, versionierte Fassung auf. Sie ist
> **kein** Steuer- oder Rechtsberatungsersatz – im Zweifel Steuerberater:in fragen.

| Feld | Wert |
|---|---|
| Unternehmen | `<Firmenname>` |
| Verantwortliche Person | `<Name>` |
| Steuernummer / USt-IdNr | `<…>` |
| Eingesetzte Software | GoBDesk `<Version>` |
| Stand dieser Dokumentation | `<JJJJ-MM-TT>` |
| Version dieser Dokumentation | `<z. B. 1.0>` |

---

## 1. Allgemeine Beschreibung

GoBDesk ist eine lokal installierte Desktop-Anwendung für `<Firmenname>` zur
**Kundenverwaltung**, zur Erstellung **rechtssicherer B2B-E-Rechnungen**
(ZUGFeRD/Factur-X, Profil EN 16931, hybrides PDF/A-3) sowie zur
**Einnahmen-Überschuss-Rechnung (EÜR)** nach dem Zufluss-/Abflussprinzip
(§ 11 EStG). Es werden folgende steuerrelevante Daten verarbeitet und aufbewahrt:

- Stammdaten der Kund:innen,
- Ausgangsrechnungen inkl. der erzeugten PDF/A-3- und XML-Artefakte,
- Zahlungen (inkl. Teilzahlungen) zu Rechnungen,
- Betriebsausgaben (Belege) mit EÜR-Kategorie,
- **Aufträge** als Klammer über Rechnungen/Dokumente/Ausgaben (mit fortlaufender
  Auftragsnummer),
- **Dokumente** (Verträge, Belege u. Ä.) im integrierten Dokumentenmanagement,
  verknüpft mit Kunden/Rechnungen/Aufträgen, mit Volltextsuche (OCR).

Die Anwendung arbeitet **offline**; es findet keine Übertragung an Dritte statt.

## 2. Ordnungsmäßigkeit und Unveränderbarkeit (Kern der GoBD)

Belegfunktion, Nachvollziehbarkeit und Unveränderbarkeit werden technisch
sichergestellt:

- **Festschreibung:** Eine Rechnung wird mit dem Festschreiben auf `issued`
  gesetzt und in diesem Moment inhaltlich eingefroren (Positionen, Summen). Als
  **Snapshots** mitgespeichert werden der Steuermodus (Kleinunternehmer § 19 UStG
  vs. Regelbesteuerung), der **Käufername**, die **Rechnungsanschrift** und – falls
  zugeordnet – die **Auftragsnummer**. Spätere Änderungen an den Stammdaten verändern
  den Beleg nicht; ein inhaltlich identisches Mehrstück bleibt damit auch aus den
  Tabellendaten reproduzierbar (GoBD Rz. 76).
- **Sperre gegen Änderung/Löschung:** Datenbank-Trigger blockieren jedes UPDATE
  und DELETE auf festgeschriebenen und stornierten Rechnungen und deren Positionen.
  Der einzige zulässige Übergang ist die Storno-Kennzeichnung selbst.
- **Storno-/Korrekturverfahren (Rz. 64, 93):** Eine festgeschriebene Rechnung wird
  nie geändert, sondern über die Funktion „Stornieren" durch eine **eigene,
  festgeschriebene Stornorechnung** (Gegenbeleg mit negierten Mengen) ausgeglichen.
  Die Rückbeziehbarkeit ist dreifach gesichert: Verweis in der Datenbank
  (Original ↔ Stornobeleg), Journaleintrag mit Grund sowie maschinenlesbare
  Referenz in der E-Rechnung (BT-25) und auf dem PDF („Storno zu Rechnung …").
  Erhaltene Zahlungen und Rückzahlungen (negative Beträge) bleiben als reale
  Zu-/Abflüsse in der EÜR erhalten.
- **Fortlaufende Nummernkreise:** Rechnungs- und Auftragsnummern werden lückenlos
  und atomar vergeben; Stornorechnungen erhalten eine eigene fortlaufende Nummer.
- **Beleg-Prüfsumme (`content_hash`):** Über die inhaltlichen Kerndaten jeder
  festgeschriebenen Rechnung (Nummer, Datum, Kunde, Beträge, Steuermodus,
  Auftragsnummer) wird ein SHA-256 gebildet und gespeichert; er lässt sich jederzeit
  neu berechnen und erkennt so nachträgliche Datenänderungen.
- **Byte-genaue Datei-Integrität:** Von den erzeugten PDF/A-3- und XML-Dateien wird
  bei der Festschreibung ein SHA-256 gespeichert und im Journal verankert; die
  Prüfung meldet fehlende oder veränderte Dateien.
- **Manipulationserkennbare Journalführung (Audit-Kette):** Jede protokollierte
  Aktion wird in einem append-only-Journal mit einer **SHA-256-Hash-Kette**
  gesichert (jeder Eintrag verkettet den Hash des Vorgängers). Nachträgliche
  Änderungen brechen die Kette und sind damit erkennbar.
- **Journal-Abgleich der Nebenaufzeichnungen:** Zahlungen und Ausgaben werden bei
  Erfassung und Korrektur mit vollständigem Snapshot (bei Korrekturen inkl.
  Vorzustand) journalisiert. Die Selbstprüfung gleicht die Tabellen gegen diese
  manipulationssicheren Journal-Snapshots ab und erkennt so Einfügen, Ändern oder
  Löschen an der Anwendung vorbei.
- **Dokumentenschutz:** Der Eingang jedes Dokuments wird mit SHA-256-Prüfsumme
  journalisiert (Rz. 117); als Beleg verknüpfte Dokumente können nicht gelöscht,
  sondern nur **archiviert** werden; Metadaten-Änderungen, OCR-Korrekturen,
  Archivierungen und (nur bei unverknüpften Dokumenten zulässige) Löschungen
  werden journalisiert.
- **Selbstprüfung:** Die Integrität lässt sich jederzeit prüfen (Dashboard →
  „**GoBD-Prüfung starten**"). Der Bericht umfasst sieben Prüfungen: Journal-Hash-Kette,
  Beleg-Prüfsummen, Rechnungsdateien (byte-genau), Schreibschutz-Trigger,
  Journal-Abgleich der Zahlungen/Ausgaben, DMS-Dokument-Prüfsummen sowie einen
  Hinweis zur **Zeitgerechtheit** (alte, nicht festgeschriebene Entwürfe, Rz. 45 ff.).
  Zusätzlich läuft beim Start ein automatischer Kurz-Check; Befunde erscheinen
  als Warnung im Dashboard.
- **Schutz gegen Uhr-Manipulation:** Steht die Systemuhr deutlich vor dem letzten
  Journaleintrag, verweigert die Software die Festschreibung; rückläufige
  Zeitstempel im Bestand werden in der Prüfung ausgewiesen.
- **Einsehbarer Nachweis (Journal):** Der vollständige, chronologische Vorgangs-
  nachweis ist in der App unter „**Journal**" direkt einsehbar (Zeitpunkt, Vorgang,
  Beleg, sichtbare Hash-Verkettung je Eintrag) und als **CSV/JSON exportierbar** –
  so lässt sich die lückenlose Nachverfolgung für einen sachverständigen Dritten
  unmittelbar prüfen. In der Rechnungs-Detailansicht ist zusätzlich die
  beleg­bezogene Historie sichtbar.
- **Protokollierte Vorgänge:** Festschreibung, Erzeugung der E-Rechnungsdateien,
  Zahlungseingänge und -stornos sowie Ausgaben-Korrekturen werden als
  Journaleinträge nachvollziehbar; die Historie bleibt erhalten.

## 3. Anwenderdokumentation (Ablauf im Betrieb)

1. **Kunde anlegen** (Kunden → „+ Neuer Kunde").
2. **Auftrag anlegen (optional)** (Aufträge → „+ Neuer Auftrag"): fasst Rechnungen,
   Dokumente und Ausgaben unter einer Auftragsnummer zusammen; Rechnung/Dokument
   können direkt „aus dem Auftrag heraus" erstellt werden.
3. **Rechnung erstellen** (Rechnungen → „+ Neue Rechnung"): Positionen erfassen,
   Live-Summen prüfen, optional Vorschau. Speichern als **Entwurf** (änderbar) oder
   **Festschreiben** (endgültig, erzeugt das ZUGFeRD-PDF/A-3). Eine zugeordnete
   Auftragsnummer erscheint auf der Rechnung.
4. **Zahlungen erfassen** in der Rechnungs-Detailansicht – auch Teilbeträge mit
   eigenem Datum (Ratenzahlung).
5. **Ausgaben erfassen** (EÜR → „+ Neue Ausgabe").
6. **Dokumente ablegen (optional)** (Dokumente → Import/Drag&Drop): Verträge/Belege
   mit Typ, Tags und Verknüpfung zu Kunde/Rechnung/Auftrag; Volltextsuche via OCR.
7. **EÜR auswerten** je Jahr; Einnahmen nach Zahlungseingang (anteilig je Rate).
8. **Rechnung stornieren (bei Fehlern):** Rechnungs-Detailansicht → „Stornieren…"
   (optional mit Grund). Es entsteht ein festgeschriebener Stornobeleg; das
   Original bleibt unverändert erhalten.
9. **Integrität prüfen** (Dashboard → „GoBD-Prüfung starten"), **Journal einsehen/
   exportieren** (Nav → Journal) und **Sicherung erstellen** (Einstellungen →
   Daten & Sicherung) – siehe § 6.
10. **Bei Betriebsprüfung:** Einstellungen → „Betriebsprüfung – Datenzugriff (Z3)"
    erzeugt den CSV-Gesamtexport inkl. Datensatzbeschreibung und
    Beschreibungsstandard (`index.xml`, IDEA-Direktimport) für die
    Datenüberlassung (§ 147 Absatz 6 AO).
11. **Empfangene E-Rechnungen** (ZUGFeRD/XRechnung) werden beim DMS-Import
    automatisch erkannt; die Kerndaten lassen sich per Klick als Ausgabe
    übernehmen (Beleg wird automatisch verknüpft). Das Original bleibt
    unverändert im Empfangsformat aufbewahrt.
12. **Verfahrensdokumentation aktualisieren:** Einstellungen →
    „Verfahrensdokumentation" öffnet ein Formular für die organisatorischen
    Angaben (werden gespeichert und direkt in das Dokument eingesetzt) und
    exportiert die aus den Systemdaten vorausgefüllte Fassung als **PDF** oder
    Markdown; jeder Export wird mit Prüfsumme im Journal verankert
    (Versionierungsnachweis). Danach ausdrucken und unterschreiben.

## 4. Technische Systemdokumentation

- **Anwendung:** GoBDesk (Electron/TypeScript), lokal installiert unter Windows.
- **Datenbank:** SQLite (Datei `gobdesk.sqlite`) im Datenspeicherort (siehe § 5),
  Betrieb im WAL-Modus, Fremdschlüssel aktiv, Transaktionen atomar.
- **E-Rechnungs-Erzeugung:** integrierter Sidecar erzeugt das hybride PDF/A-3 mit
  eingebettetem EN-16931-XML (Profil EN 16931, XSD- und Schematron-geprüft); das PDF
  ist als PDF/A-3b validiert. Eine zugeordnete Auftragsnummer wird als
  Verkäufer-Auftragsreferenz (BT-14) ins XML übernommen. Erforderliche Laufzeit
  (Rendering, PDF/A-Konvertierung, OCR) ist **im Programm gebündelt** – der Anwender
  installiert nichts zusätzlich.
- **Aufbewahrungsformat:** Rechnungen liegen als PDF/A-3 (langzeitarchivtauglich)
  mit maschinenlesbarem XML vor. Zu jeder festgeschriebenen Rechnung wird die
  SHA-256-Prüfsumme der Dateien gespeichert, sodass unbemerkte Änderungen an den
  archivierten Dateien erkannt werden.

## 5. Datenspeicherort

- **Standard:** `%APPDATA%\gobdesk\` (Datenbank `gobdesk.sqlite`, Ordner `invoices\`
  mit den Rechnungs-PDF/XML und Ordner `documents\` mit den abgelegten Dokumenten).
- **Abweichender Speicherort:** in Einstellungen → Daten & Sicherung wählbar
  (z. B. verschlüsseltes Laufwerk, NAS). Beim Wechsel werden die Daten in den neuen
  Ordner kopiert, die internen Verweise angepasst und die bisherigen Dateien als
  Sicherheit belassen.
- Aktuell genutzter Speicherort: `<Pfad eintragen>`.

## 6. Datensicherung (IKS)

- **Sicherung:** Einstellungen → Daten & Sicherung → „Sicherung erstellen…".
  Erzeugt einen zeitgestempelten, **schreibgeschützten** Snapshot-Ordner mit einer
  konsistenten Kopie der Datenbank, der Rechnungs-PDF/XML (`invoices\`) und der
  Dokumente (`documents\`) sowie einem `manifest.json` (App-Version, Zeitpunkt,
  SHA-256 der DB, Ergebnis der Audit-Ketten-Prüfung).
- **Turnus:** `<z. B. wöchentlich sowie nach Monats-/Jahresabschluss>`.
  Die Software erinnert automatisch, wenn die letzte Sicherung älter als
  7 Tage ist (Dashboard-Hinweis). Jede erstellte Sicherung wird zusätzlich mit
  Ziel, Größe und DB-Prüfsumme im revisionssicheren Journal protokolliert
  (IKS-Nachweis, im Journal unter „System" filterbar).
- **Aufbewahrungsort der Sicherungen:** `<z. B. externe, schreibgeschützte
  Datenträger / verschlüsselter Cloud-Speicher>`, getrennt vom Arbeitsgerät.
- **Aufbewahrungsfristen** (Beginn: Schluss des Kalenderjahres, § 147 Absatz 4 AO):
  - **Bücher, Aufzeichnungen, Journal** (inkl. EÜR-Daten und Datenbank): **10 Jahre**,
  - **Buchungsbelege** – insbesondere Ausgangs- und Eingangsrechnungen: **8 Jahre**
    (§ 147 Absatz 3 AO i. d. F. des Vierten Bürokratieentlastungsgesetzes, ab 2025;
    zuvor entstandene Belege mit noch laufender 10-Jahres-Frist bleiben unberührt,
    soweit die Frist Ende 2024 noch nicht abgelaufen war),
  - **Handels-/Geschäftsbriefe** (z. B. Angebote mit Auftragsfolge,
    Auftragsbestätigungen): **6 Jahre**.
  Die Software löscht selbst nichts – die Fristenkontrolle obliegt dem Anwender.
- **Wiederherstellungstest:** `<Datum des letzten erfolgreichen Tests>`.

## 7. Internes Kontrollsystem (Kurzform)

- Zugriffsschutz auf das Gerät/den Datenspeicherort: `<Beschreibung>`.
- Regelmäßige Integritätsprüfung („GoBD-Prüfung starten" im Dashboard).
- Vier-Augen-/Plausibilitätsprüfung vor dem Festschreiben von Rechnungen.

## 8. Aufbewahrung und Verfügbarkeit

Steuerrelevante Unterlagen werden über die gesetzliche Frist unveränderbar,
vollständig und maschinell auswertbar aufbewahrt. Die PDF/A-3-Rechnungen sind aus
sich heraus lesbar; die Datenbank bleibt zur Auswertung verfügbar.

## 9. Änderungshistorie dieser Verfahrensdokumentation

| Version | Datum | Autor:in | Änderung |
|---|---|---|---|
| `<1.0>` | `<JJJJ-MM-TT>` | `<Name>` | Erstfassung |
