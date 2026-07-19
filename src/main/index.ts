/** Electron-Hauptprozess: Fenster, DB-Init, IPC. */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, Menu, nativeTheme } from "electron";
import type Database from "better-sqlite3";

import { listJournal, listJournalForInvoice, verifyAuditChain, verifyGobd } from "../core/gobd.js";
import { initDatabase } from "./db.js";
import { createExpense, euerReport, getExpense, listEuerYears, updateExpense } from "./expenses.js";
import {
  addPayment,
  artifactPath,
  cancelInvoiceWithPdf,
  createDraftInvoice,
  getInvoice,
  issueInvoiceWithPdf,
  listInvoices,
  previewDraftPdf,
  updateDraftInvoice,
} from "./invoices.js";
import { exportZ3 } from "./export.js";
import { generateVerfahrensdok, renderVerfdokHtml, saveVerfdokTexts } from "./verfdok.js";
import { validateInvoice, terminateSidecars } from "./sidecar.js";
import { fileSha256 } from "./hash.js";
import { getDataDir } from "./config.js";
import {
  archiveDocument,
  deleteDocument,
  getDocument,
  importDocument,
  importDocumentWithOcr,
  linkDocument,
  listDocuments,
  listDocumentsForTarget,
  setDocumentOrder,
  updateDocument,
  updateDocumentOcr,
} from "./documents.js";
import { createOrder, getOrder, listOrders } from "./orders.js";
import { registerIpc } from "./ipc.js";
import { createBackup } from "./storage.js";
import {
  createCustomer,
  getCustomer,
  getSettings,
  listCustomers,
  listCustomersDetailed,
  runDemoInvoice,
  updateCustomer,
  updateSettings,
} from "./repository.js";
import { configureRuntime, getSidecarDir } from "./runtime.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));

/** Farben der überlagerten Fensterknöpfe passend zum hellen/dunklen Theme. */
function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? "#1c222c" : "#ffffff",
    symbolColor: dark ? "#e6e9ef" : "#1c2330",
    height: 44,
  };
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: false,
    // Im Paket liefert electron-builder das Exe-Icon; im Dev setzen wir es direkt.
    ...(app.isPackaged ? {} : { icon: path.join(app.getAppPath(), "build", "icon.ico") }),
    titleBarStyle: "hidden",
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(dirname, "../preload/index.mjs"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  nativeTheme.on("updated", () => {
    if (!win.isDestroyed()) win.setTitleBarOverlay(overlayColors());
  });

  win.on("ready-to-show", () => win.show());

  // DevTools-Konsole per F12 bzw. Strg+Umschalt+I (Menüleiste ist ausgeblendet).
  win.webContents.on("before-input-event", (_event, input) => {
    const toggle =
      input.type === "keyDown" &&
      (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"));
    if (toggle) win.webContents.toggleDevTools();
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(dirname, "../renderer/index.html"));
}

/** Headless-Selbsttest (GOBDESK_SMOKE=1): prüft DB/IPC-Kern unter Electron ohne Fenster. */
async function headlessSmoke(db: Database.Database): Promise<number> {
  let ok = false;
  const out: Record<string, unknown> = {};
  try {
    const settings = getSettings(db);
    // Firma wird nicht mehr mit Beispieldaten geseedet -> für die PDF-Erzeugung setzen.
    updateSettings(db, {
      legal_name: "Musterberatung Rouven",
      address_line1: "Beispielweg 1",
      zip: "50667",
      city: "Köln",
      country_iso: "DE",
      tax_number: "214/123/45678",
      vat_id: "DE123456789",
      is_kleinunternehmer: 0,
      email: "info@musterberatung.de",
      iban: "DE02120300000000202051",
      bic: "BYLADEM1001",
    });
    const settingsOk = getSettings(db)?.legal_name === "Musterberatung Rouven";
    const demo = runDemoInvoice(db);
    const auditIntact = verifyAuditChain(db) === null;

    const cid = createCustomer(db, {
      kind: "company",
      company_name: "Neu GmbH",
      contact_last_name: null,
      street: null,
      zip: null,
      city: "Hamburg",
      country_iso: "DE",
      email: null,
      vat_id: null,
    });
    const existing = getCustomer(db, cid);
    if (existing) updateCustomer(db, cid, { ...existing, company_name: "Neu AG" });
    const customerCrud = cid > 0 && getCustomer(db, cid)?.company_name === "Neu AG";

    const custId = (db.prepare("SELECT id FROM customers ORDER BY id LIMIT 1").get() as {
      id: number;
    }).id;
    const draftId = createDraftInvoice(db, {
      customer_id: custId,
      issue_date: "2026-07-08",
      service_date: "2026-06-30",
      payment_terms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [
        { description: "Beratung", quantity_milli: 8000, unit: "HUR", unit_price_net_cents: 9000, tax_rate_bp: 1900 },
        { description: "Fachbuch", quantity_milli: 2000, unit: "C62", unit_price_net_cents: 2500, tax_rate_bp: 700 },
      ],
    });

    updateDraftInvoice(db, draftId, {
      customer_id: custId,
      issue_date: "2026-07-08",
      service_date: "2026-06-30",
      payment_terms: "Zahlbar innerhalb von 14 Tagen.",
      lines: [
        { description: "Beratung (bearbeitet)", quantity_milli: 8000, unit: "HUR", unit_price_net_cents: 9000, tax_rate_bp: 1900 },
        { description: "Fachbuch", quantity_milli: 2000, unit: "C62", unit_price_net_cents: 2500, tax_rate_bp: 700 },
      ],
    });
    const editedDraft = getInvoice(db, draftId);
    const draftEditOk =
      editedDraft?.items[0]?.description === "Beratung (bearbeitet)" && editedDraft?.items.length === 2;
    out.draftEdit = draftEditOk;

    const pdfOpts = {
      invoicesDir: path.join(app.getPath("temp"), "gobdesk-smoke-invoices"),
      sidecarDir: getSidecarDir(),
    };
    const issued = await issueInvoiceWithPdf(db, draftId, pdfOpts);
    const pdfExists = Boolean(issued.pdf_path) && existsSync(issued.pdf_path as string);

    // EN-16931-Validierung der festgeschriebenen Rechnung (XSD + Schematron).
    const validation = await validateInvoice(issued.pdf_path as string, pdfOpts.sidecarDir);
    const validateOk = validation.ok === true && validation.valid === true;
    out.validate = { valid: validation.valid, errors: validation.errors?.length ?? 0 };

    // PDF-Vorschau (Basis-Layout) liefert PDF-Bytes.
    const previewBytes = await previewDraftPdf(
      db,
      {
        customer_id: custId,
        issue_date: "2026-07-08",
        service_date: "2026-06-30",
        payment_terms: "Vorschau",
        lines: [
          { description: "Vorschau-Pos", quantity_milli: 1000, unit: "C62", unit_price_net_cents: 5000, tax_rate_bp: 1900 },
        ],
      },
      pdfOpts.sidecarDir,
      path.join(app.getPath("temp"), "gobdesk-smoke-preview"),
    );
    const previewOk = previewBytes.length > 1000 && previewBytes[0] === 0x25; // "%PDF"
    out.preview = { bytes: previewBytes.length, ok: previewOk };

    addPayment(db, draftId, "2026-07-01", 40000, "1. Rate");
    const detail = getInvoice(db, draftId);
    const paymentOk = detail?.paid_cents === 40000 && detail?.payment_status === "teilweise";
    out.payment = {
      paid: detail?.paid_cents,
      remaining: detail?.remaining_cents,
      status: detail?.payment_status,
    };

    const filterAll = listInvoices(db).length;
    const filterByCustomer = listInvoices(db, { customerId: custId }).length;
    const filterNone = listInvoices(db, { customerId: 999999 }).length;
    const filterOk = filterAll > 0 && filterByCustomer > 0 && filterNone === 0;
    out.filter = { all: filterAll, byCustomer: filterByCustomer, none: filterNone };

    const catId = (db
      .prepare("SELECT id FROM euer_categories WHERE kind = 'expense' ORDER BY sort_order LIMIT 1")
      .get() as { id: number }).id;
    const expenseId = createExpense(db, {
      expense_date: "2026-05-10",
      payment_date: "2026-05-10",
      description: "Büromaterial",
      vendor: "Bürohaus",
      category_id: catId,
      gross_cents: 11900,
      tax_rate_bp: 1900,
      deductible_permille: 1000,
    });
    const before = getExpense(db, expenseId);
    updateExpense(db, expenseId, { ...before!, description: "Büromaterial (korrigiert)" });
    const editApplied = getExpense(db, expenseId)?.description === "Büromaterial (korrigiert)";
    const auditAfterEdit = verifyAuditChain(db) === null;
    out.expenseEdit = editApplied && auditAfterEdit;
    // Proportionaler Zufluss (§11 EStG): Rechnung (100 % netto, brutto 119 000)
    // in zwei gleichen Raten über zwei Jahre → je Jahr genau die Hälfte netto.
    const incomeBefore2026 = euerReport(db, 2026).income_net_cents;
    const incomeBefore2027 = euerReport(db, 2027).income_net_cents;
    const splitDraft = createDraftInvoice(db, {
      customer_id: custId,
      issue_date: "2026-02-01",
      service_date: "2026-02-01",
      payment_terms: "Zahlbar in zwei Raten.",
      lines: [
        { description: "Projektarbeit", quantity_milli: 1000, unit: "C62", unit_price_net_cents: 100000, tax_rate_bp: 1900 },
      ],
    });
    await issueInvoiceWithPdf(db, splitDraft, pdfOpts);
    addPayment(db, splitDraft, "2026-03-01", 59500, "1. Rate");
    addPayment(db, splitDraft, "2027-03-01", 59500, "2. Rate");
    const proportional2026 = euerReport(db, 2026).income_net_cents - incomeBefore2026;
    const proportional2027 = euerReport(db, 2027).income_net_cents - incomeBefore2027;
    const proportionalOk = proportional2026 === 50000 && proportional2027 === 50000;
    out.proportional = { y2026: proportional2026, y2027: proportional2027 };

    const euer = euerReport(db, 2026);
    const euerYears = listEuerYears(db);
    out.euerYears = euerYears;
    const euerOk =
      euer.income_net_cents > 0 &&
      euer.expenses_total_cents > 0 &&
      editApplied &&
      auditAfterEdit &&
      euerYears.includes(2026) &&
      proportionalOk;

    // DMS: Dokument importieren, per Volltext finden, Dublette erkennen, entfernen.
    const docSrc = path.join(app.getPath("temp"), `gobdesk-smoke-doc-${Date.now()}.txt`);
    writeFileSync(docSrc, `Smoke-Testdokument Vertrag ${Date.now()}`, "utf8");
    const imp = importDocument(db, docSrc);
    updateDocument(db, imp.id, {
      title: "Smoke Vertrag Alpha",
      document_type_id: null,
      customer_id: custId,
      doc_date: "2026-05-01",
      tags: ["wichtig", "test"],
    });
    const docFound = listDocuments(db, { search: "Alpha" }).some((d) => d.id === imp.id);
    const docDupe = importDocument(db, docSrc).duplicate;
    linkDocument(db, imp.id, "invoice", draftId);
    const docDetail = getDocument(db, imp.id);
    const linkOnDoc = (docDetail?.links ?? []).some(
      (l) => l.target_type === "invoice" && l.target_id === draftId,
    );
    const linkReverse = listDocumentsForTarget(db, "invoice", draftId).some((d) => d.id === imp.id);
    // OCR-Korrektur: geänderter Volltext wird journalisiert und ist durchsuchbar.
    updateDocumentOcr(db, imp.id, "Korrigierter Volltext Zebrastreifen");
    const ocrEditOk = listDocuments(db, { search: "Zebrastreifen" }).some((d) => d.id === imp.id);

    // Löschschutz: als Beleg verknüpfte Dokumente sind nicht löschbar (nur Archiv).
    let deleteBlocked = false;
    try {
      deleteDocument(db, imp.id);
    } catch {
      deleteBlocked = true;
    }
    archiveDocument(db, imp.id, true);
    const archivedHidden = !listDocuments(db).some((d) => d.id === imp.id);
    const archivedVisible = listDocuments(db, { includeArchived: true }).some(
      (d) => d.id === imp.id && d.is_archived === 1,
    );

    const dmsOk =
      imp.id > 0 &&
      docFound &&
      docDupe &&
      docDetail?.tags.includes("wichtig") === true &&
      docDetail?.customer_name != null &&
      linkOnDoc &&
      linkReverse &&
      ocrEditOk &&
      deleteBlocked &&
      archivedHidden &&
      archivedVisible;
    out.dms = {
      imported: imp.id,
      found: docFound,
      dupe: docDupe,
      tags: docDetail?.tags,
      link: linkOnDoc && linkReverse,
      ocrEdit: ocrEditOk,
      deleteBlocked,
      archive: archivedHidden && archivedVisible,
    };

    // Aufträge: anlegen, Rechnung + Dokument zuordnen, Detail prüfen.
    const orderId = createOrder(db, {
      order_number: null,
      customer_id: custId,
      title: "Testauftrag",
      status: "offen",
      order_date: "2026-05-01",
      notes: null,
    });
    const orderDraft = createDraftInvoice(db, {
      customer_id: custId,
      issue_date: "2026-05-02",
      service_date: "2026-05-01",
      payment_terms: null,
      order_id: orderId,
      lines: [
        { description: "Auftragsposition", quantity_milli: 1000, unit: "C62", unit_price_net_cents: 12345, tax_rate_bp: 1900 },
      ],
    });
    // Auftragsgebundene Rechnung festschreiben: Auftragsnummer landet eingefroren im
    // content_hash, im PDF-Kopf und als BT-14 im XML → EN-16931-Validierung muss halten.
    const orderInvoiceNumber = getOrder(db, orderId)?.order_number ?? "";
    const orderIssued = await issueInvoiceWithPdf(db, orderDraft, pdfOpts);
    const orderValidation = await validateInvoice(orderIssued.pdf_path as string, pdfOpts.sidecarDir);
    const orderSnapshot = getInvoice(db, orderDraft);
    out.orderInvoice = {
      number: orderIssued.invoiceNumber,
      valid: orderValidation.valid,
      orderNumber: orderInvoiceNumber,
    };

    const orderDocSrc = path.join(app.getPath("temp"), `gobdesk-smoke-orderdoc-${Date.now()}.txt`);
    writeFileSync(orderDocSrc, "Auftrags-Dokument", "utf8");
    const orderDoc = importDocument(db, orderDocSrc);
    setDocumentOrder(db, orderDoc.id, orderId);
    const orderDetail = getOrder(db, orderId);
    const ordersOk =
      orderId > 0 &&
      orderSnapshot?.order_id === orderId &&
      orderSnapshot?.order_number === orderInvoiceNumber &&
      orderValidation.ok === true &&
      orderValidation.valid === true &&
      (orderDetail?.invoices.some((i) => i.id === orderDraft) ?? false) &&
      (orderDetail?.documents.some((d) => d.id === orderDoc.id) ?? false) &&
      /^\d{4}-A\d{4}$/.test(orderDetail?.order_number ?? "");
    out.orders = {
      id: orderId,
      number: orderDetail?.order_number,
      invoices: orderDetail?.invoices.length,
      documents: orderDetail?.documents.length,
    };
    // Auftragszuordnung lösen -> unverknüpft -> Löschung erlaubt (journalisiert).
    setDocumentOrder(db, orderDoc.id, null);
    deleteDocument(db, orderDoc.id);

    // Filter/Kennzahlen: Kundenliste mit Aggregaten + Auftrags-Statusfilter.
    const custDetailed = listCustomersDetailed(db).find((c) => c.id === custId);
    const orderFilterOk = listOrders(db, { status: "offen" }).some((o) => o.id === orderId);
    const filtersOk =
      (custDetailed?.invoice_count ?? 0) > 0 && (custDetailed?.open_cents ?? 0) > 0 && orderFilterOk;
    out.filters = {
      customerInvoices: custDetailed?.invoice_count,
      customerOpen: custDetailed?.open_cents,
      orderStatusFilter: orderFilterOk,
    };

    // Storno (GoBD Rz. 64/93): Original bleibt unverändert, festgeschriebener
    // Gegenbeleg mit negierten Mengen gleicht aus, Referenz in DB/Journal/XML.
    const cancelDraft = createDraftInvoice(db, {
      customer_id: custId,
      issue_date: "2026-06-01",
      service_date: "2026-06-01",
      payment_terms: "Zahlbar sofort.",
      lines: [
        { description: "Fehlbuchung", quantity_milli: 1000, unit: "C62", unit_price_net_cents: 10000, tax_rate_bp: 1900 },
      ],
    });
    const cancelIssued = await issueInvoiceWithPdf(db, cancelDraft, pdfOpts);
    const cancelRes = await cancelInvoiceWithPdf(db, cancelDraft, "Falsche Position", pdfOpts);
    const origAfter = getInvoice(db, cancelDraft);
    const stornoInv = getInvoice(db, cancelRes.stornoId);
    // Sperr-Trigger: stornierte Originale und Stornobelege bleiben unveränderbar.
    let cancelledLocked = false;
    try {
      db.prepare("UPDATE invoices SET notes = 'manipuliert' WHERE id = ?").run(cancelDraft);
    } catch {
      cancelledLocked = true;
    }
    let doubleCancelBlocked = false;
    try {
      await cancelInvoiceWithPdf(db, cancelDraft, null, pdfOpts);
    } catch {
      doubleCancelBlocked = true;
    }
    // Stornorechnung (negative Beträge + BT-25) muss EN 16931 bestehen.
    const stornoValidation = await validateInvoice(cancelRes.pdf_path as string, pdfOpts.sidecarDir);
    // Datei-Inhalt gegen DB: Das erzeugte XML muss exakt die DB-Beträge tragen.
    // Fängt Rundungsabweichungen zwischen App (TS) und Sidecar (Python) – eine
    // „in sich konsistente" Datei besteht die EN-16931-Validierung sonst trotzdem.
    const euroXml = (c: number): string => (c / 100).toFixed(2);
    const stornoXmlPath = artifactPath(db, cancelRes.stornoId, "xml");
    const stornoXml = stornoXmlPath ? readFileSync(stornoXmlPath, "utf8") : "";
    const xmlAmountsOk =
      stornoXml.includes(`>${euroXml(stornoInv?.gross_total_cents ?? 0)}<`) &&
      stornoXml.includes(`>${euroXml(stornoInv?.net_total_cents ?? 0)}<`);
    // Rückzahlung (negativer Zufluss) auf die stornierte Rechnung erfassen.
    addPayment(db, cancelDraft, "2026-06-10", -cancelIssued.gross_total_cents, "Rückzahlung nach Storno");
    const stornoOk =
      origAfter?.status === "cancelled" &&
      origAfter.cancelled_by_invoice_id === cancelRes.stornoId &&
      origAfter.cancelled_by_number === cancelRes.stornoNumber &&
      stornoInv?.cancels_invoice_id === cancelDraft &&
      stornoInv?.cancels_number === cancelIssued.invoiceNumber &&
      stornoInv?.gross_total_cents === -cancelIssued.gross_total_cents &&
      cancelledLocked &&
      doubleCancelBlocked &&
      stornoValidation.ok === true &&
      stornoValidation.valid === true &&
      xmlAmountsOk;
    out.storno = {
      ok: stornoOk,
      original: cancelIssued.invoiceNumber,
      storno: cancelRes.stornoNumber,
      stornoGross: stornoInv?.gross_total_cents,
      locked: cancelledLocked,
      doubleBlocked: doubleCancelBlocked,
      valid: stornoValidation.valid,
      xmlAmounts: xmlAmountsOk,
    };

    // OCR/Textextraktion: der PDF-Textlayer (Verkäufername) wird durchsuchbar.
    // Gleichzeitig: das eigene ZUGFeRD-PDF muss als E-Rechnung erkannt werden
    // (Empfangs-Komfort: Kerndaten für die Übernahme als Ausgabe).
    let ocrOk = false;
    let einvoiceOk = false;
    if (issued.pdf_path) {
      const pdfDoc = await importDocumentWithOcr(db, issued.pdf_path, pdfOpts.sidecarDir);
      ocrOk = listDocuments(db, { search: "Musterberatung" }).some((d) => d.id === pdfDoc.id);
      const einv = getDocument(db, pdfDoc.id)?.einvoice;
      einvoiceOk =
        einv?.syntax === "CII" &&
        einv.number === issued.invoiceNumber &&
        einv.gross_cents === issued.gross_total_cents &&
        einv.seller === "Musterberatung Rouven";
      out.ocr = { found: ocrOk };
      out.einvoice = {
        ok: einvoiceOk,
        syntax: einv?.syntax,
        number: einv?.number,
        gross: einv?.gross_cents,
        rate: einv?.tax_rate_bp,
      };
      deleteDocument(db, pdfDoc.id);
    }

    // Backup/Sicherung: konsistenter Snapshot inkl. Manifest; jede Sicherung
    // wird als IKS-Nachweis in der Hash-Kette verankert.
    const backup = await createBackup(db, path.join(app.getPath("temp"), "gobdesk-smoke-backup"));
    const backupJournaled =
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'backup' AND action = 'CREATE'",
          )
          .get() as { n: number }
      ).n > 0;
    const backupOk =
      existsSync(path.join(backup.path, "gobdesk.sqlite")) &&
      existsSync(path.join(backup.path, "manifest.json")) &&
      backup.auditOk &&
      backupJournaled;
    out.backup = {
      ok: backupOk,
      auditOk: backup.auditOk,
      journaled: backupJournaled,
      dataDir: getDataDir(),
    };

    // Datenzugriff Z3: CSV-Gesamtexport inkl. Datensatzbeschreibung und
    // Beschreibungsstandard (index.xml + DTD) für den IDEA-Direktimport.
    const z3 = exportZ3(db, path.join(app.getPath("temp"), "gobdesk-smoke-z3"));
    const indexXml = existsSync(path.join(z3.path, "index.xml"))
      ? readFileSync(path.join(z3.path, "index.xml"), "utf8")
      : "";
    const z3Ok =
      z3.files > 12 &&
      existsSync(path.join(z3.path, "DATENSATZBESCHREIBUNG.md")) &&
      existsSync(path.join(z3.path, "invoices.csv")) &&
      existsSync(path.join(z3.path, "audit_log.csv")) &&
      existsSync(path.join(z3.path, "gdpdu-01-08-2002.dtd")) &&
      indexXml.includes("<DataSet>") &&
      indexXml.includes("<URL>invoices.csv</URL>") &&
      indexXml.includes("<References>customers</References>");
    out.z3 = { ok: z3Ok, files: z3.files };

    // Verfahrensdokumentations-Generator: Systemdaten UND die hinterlegten
    // organisatorischen Angaben landen im Dokument; die HTML-Fassung
    // (Grundlage des PDF-Exports) rendert die Kernstruktur korrekt.
    const smokeText = "Smoke-Test: IT-Beratung und Softwareentwicklung.";
    saveVerfdokTexts(db, { business: smokeText });
    const verfdok = generateVerfahrensdok(db);
    const verfdokHtml = renderVerfdokHtml(verfdok);
    const verfdokOk =
      verfdok.includes("Musterberatung Rouven") &&
      verfdok.includes("Journal-Hash-Kette") === false && // Fließtext, kein Debug-Dump
      verfdok.includes("## 3. Technische Systemdokumentation") &&
      verfdok.includes("Migration 8") &&
      verfdok.includes(smokeText) &&
      verfdokHtml.includes("<h2>3. Technische Systemdokumentation</h2>") &&
      verfdokHtml.includes(smokeText) &&
      verfdokHtml.includes("<table>") &&
      verfdokHtml.includes("**") === false; // Inline-Markdown wurde umgesetzt
    out.verfdok = { ok: verfdokOk, length: verfdok.length, htmlLength: verfdokHtml.length };

    // Käuferanschrift-Snapshot: bei jeder Festschreibung eingefroren (Rz. 76).
    const addressSnapshotOk =
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM invoices
              WHERE status IN ('issued', 'cancelled')
                AND (buyer_address_snapshot IS NULL OR buyer_address_snapshot = '')`,
          )
          .get() as { n: number }
      ).n === 0;
    out.addressSnapshot = { ok: addressSnapshotOk };

    // GoBD-Selbstprüfung: Hash-Kette + Beleg-Prüfsummen + Datei-Hashes +
    // Schreibschutz + Nebenaufzeichnungen (Journal-Abgleich) + DMS-Dokumente.
    const gobd = verifyGobd(db, fileSha256);
    const gobdOk =
      gobd.ok &&
      gobd.invoices.hashOk === gobd.invoices.issued &&
      gobd.invoices.issued > 0 &&
      gobd.artifacts.hashChecked > 0 &&
      gobd.sideRecords.mismatches.length === 0 &&
      gobd.sideRecords.payments > 0 &&
      gobd.sideRecords.expenses > 0 &&
      gobd.documents.total > 0 &&
      gobd.documents.ok === gobd.documents.total;
    out.gobd = {
      ok: gobd.ok,
      entries: gobd.auditChain.entries,
      hashes: `${gobd.invoices.hashOk}/${gobd.invoices.issued}`,
      pdf: `${gobd.artifacts.pdfOk}/${gobd.artifacts.expectedPdf}`,
      fileHashes: gobd.artifacts.hashChecked,
      mismatch: gobd.artifacts.hashMismatch.length,
      withoutPdf: gobd.artifacts.withoutPdf.length,
      triggers: `${gobd.triggers.present}/${gobd.triggers.expected}`,
      sideRecords: `${gobd.sideRecords.paymentsOk}/${gobd.sideRecords.payments} Zahlungen, ${gobd.sideRecords.expensesOk}/${gobd.sideRecords.expenses} Ausgaben`,
      documents: `${gobd.documents.ok}/${gobd.documents.total}`,
      staleDrafts: gobd.timeliness.staleDrafts,
    };

    // Journal / Nachweis: menschenlesbarer, verketteter Vorgangsnachweis.
    const journal = listJournal(db);
    const journalForInvoice = listJournalForInvoice(db, draftId);
    const journalOk =
      journal.length > 0 &&
      journal.every((e) => e.chainOk) &&
      journal.some((e) => e.entityType === "invoice" && e.action === "ISSUE") &&
      journal.some((e) => e.entityType === "payment" && e.action === "ADD") &&
      journalForInvoice.length > 0;
    out.journal = {
      ok: journalOk,
      total: journal.length,
      forInvoice: journalForInvoice.length,
      allChained: journal.every((e) => e.chainOk),
      kinds: [...new Set(journal.map((e) => `${e.entityType}/${e.action}`))],
    };

    out.legalName = getSettings(db)?.legal_name ?? null;
    out.customers = listCustomers(db).length;
    out.demo = demo;
    out.auditIntact = auditIntact;
    out.customerCrud = customerCrud;
    out.invoice = { number: issued.invoiceNumber, gross: issued.gross_total_cents, pdf: issued.pdf_path };
    out.pdfExists = pdfExists;
    out.euer = {
      income: euer.income_net_cents,
      expenses: euer.expenses_total_cents,
      profit: euer.profit_cents,
    };
    ok =
      Boolean(settings) &&
      settingsOk &&
      demo.invoiceNumber.length > 0 &&
      auditIntact &&
      customerCrud &&
      draftEditOk &&
      pdfExists &&
      validateOk &&
      previewOk &&
      paymentOk &&
      filterOk &&
      euerOk &&
      dmsOk &&
      ordersOk &&
      filtersOk &&
      stornoOk &&
      ocrOk &&
      einvoiceOk &&
      backupOk &&
      z3Ok &&
      verfdokOk &&
      addressSnapshotOk &&
      gobdOk &&
      journalOk;
  } catch (err) {
    out.error = String(err);
  }
  out.ok = ok;
  const target = process.env["GOBDESK_SMOKE_OUT"];
  if (target) writeFileSync(target, JSON.stringify(out, null, 2), "utf8");
  console.log("[SMOKE]", JSON.stringify(out));
  return ok ? 0 : 1;
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // keine Menüleiste

  configureRuntime();
  const db = initDatabase();
  registerIpc(db);

  if (process.env["GOBDESK_SMOKE"] === "1") {
    void headlessSmoke(db).then((code) => {
      process.exitCode = code;
      app.quit();
    });
    return;
  }

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Vor dem Beenden alle noch laufenden Sidecar-Prozesse (inkl. Ghostscript/
// Tesseract) mitbeenden – sonst blieben sie als Waisen im Installationsordner
// und blockierten die nächste (Update-)Installation.
app.on("will-quit", () => terminateSidecars());

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
