/** Registriert die IPC-Handler des Main-Prozesses. */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type Database from "better-sqlite3";

import {
  appendAudit,
  listJournal,
  listJournalForInvoice,
  quickCheckGobd,
  verifyGobd,
} from "../core/gobd.js";
import { CSV_BOM } from "./csv.js";
import { fileSha256 } from "./hash.js";
import { journalToCsv, journalToJson } from "./journal.js";
import { getDataDir, getDefaultDataDir, getLastBackupAt, isCustomDataDir } from "./config.js";
import {
  archiveDocument,
  deleteDocument,
  documentPath,
  getDocument,
  importDocumentWithOcr,
  linkDocument,
  listDocuments,
  listDocumentsForTarget,
  listDocumentTypes,
  listLinkTargets,
  listTags,
  setDocumentOrder,
  unlinkDocument,
  updateDocument,
  updateDocumentOcr,
} from "./documents.js";
import {
  createOrder,
  deleteOrder,
  getOrder,
  listOrderOptions,
  listOrders,
  suggestOrderNumber,
  updateOrder,
} from "./orders.js";
import { createBackup, DB_FILENAME, moveDataDir } from "./storage.js";
import type {
  CompanySettingsInput,
  CustomerInput,
  DocumentFilter,
  DocumentTargetType,
  DocumentUpdateInput,
  DraftInvoiceInput,
  ExpenseInput,
  InvoiceFilter,
  OrderFilter,
  OrderInput,
} from "../shared/api.js";
import {
  createExpense,
  euerReport,
  getExpense,
  listEuerCategories,
  listEuerYears,
  listExpenses,
  updateExpense,
} from "./expenses.js";
import {
  addPayment,
  artifactPath,
  cancelInvoiceWithPdf,
  createDraftInvoice,
  deletePayment,
  getInvoice,
  issueInvoiceWithPdf,
  listInvoices,
  listTaxRates,
  markInvoicePaid,
  previewDraftPdf,
  updateDraftInvoice,
} from "./invoices.js";
import { exportZ3 } from "./export.js";
import {
  generateVerfahrensdok,
  getVerfdokTexts,
  renderVerfdokHtml,
  saveVerfdokTexts,
} from "./verfdok.js";
import { validateInvoice } from "./sidecar.js";
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
import { getSidecarDir } from "./runtime.js";
import { checkForUpdate, getAppInfo } from "./about.js";

/** Rendert eigenes (vertrauenswürdiges) HTML in einem unsichtbaren Fenster zu PDF. */
async function htmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({
      pageSize: "A4",
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.7, right: 0.7 },
    });
  } finally {
    win.destroy();
  }
}

export function registerIpc(db: Database.Database): void {
  const paths = {
    invoicesDir: path.join(getDataDir(), "invoices"),
    sidecarDir: getSidecarDir(),
  };

  ipcMain.handle("settings:get", () => getSettings(db));
  ipcMain.handle("settings:update", (_e, input: CompanySettingsInput) => updateSettings(db, input));

  ipcMain.handle("customers:list", () => listCustomers(db));
  ipcMain.handle("customers:listDetailed", (_e, search?: string) =>
    listCustomersDetailed(db, search),
  );
  ipcMain.handle("customers:get", (_e, id: number) => getCustomer(db, id));
  ipcMain.handle("customers:create", (_e, input: CustomerInput) => createCustomer(db, input));
  ipcMain.handle("customers:update", (_e, id: number, input: CustomerInput) =>
    updateCustomer(db, id, input),
  );

  ipcMain.handle("tax:list", () => listTaxRates(db));
  ipcMain.handle("invoices:list", (_e, filter?: InvoiceFilter) => listInvoices(db, filter));
  ipcMain.handle("invoices:createDraft", (_e, input: DraftInvoiceInput) =>
    createDraftInvoice(db, input),
  );
  ipcMain.handle("invoices:updateDraft", (_e, id: number, input: DraftInvoiceInput) =>
    updateDraftInvoice(db, id, input),
  );
  ipcMain.handle("invoices:issue", (_e, id: number) => issueInvoiceWithPdf(db, id, paths));
  ipcMain.handle("invoices:cancel", (_e, id: number, reason: string | null) =>
    cancelInvoiceWithPdf(db, id, reason, paths),
  );
  ipcMain.handle("invoices:preview", (_e, input: DraftInvoiceInput) =>
    previewDraftPdf(db, input, paths.sidecarDir, path.join(app.getPath("temp"), "gobdesk-preview")),
  );
  ipcMain.handle("invoices:validate", async (_e, id: number) => {
    const pdf = artifactPath(db, id, "pdf");
    if (!pdf) return { ok: false, error: "Zu dieser Rechnung existiert keine PDF." };
    return validateInvoice(pdf, paths.sidecarDir);
  });
  ipcMain.handle("invoices:get", (_e, id: number) => getInvoice(db, id));
  ipcMain.handle("invoices:markPaid", (_e, id: number) => markInvoicePaid(db, id));
  ipcMain.handle(
    "payments:add",
    (_e, invoiceId: number, paidAt: string, amountCents: number, note: string | null) =>
      addPayment(db, invoiceId, paidAt, amountCents, note),
  );
  ipcMain.handle("payments:delete", (_e, paymentId: number) => deletePayment(db, paymentId));
  ipcMain.handle("invoices:runDemo", () => runDemoInvoice(db));

  ipcMain.handle("artifact:open", async (_e, invoiceId: number, kind: "pdf" | "xml") => {
    const p = artifactPath(db, invoiceId, kind);
    if (p) await shell.openPath(p);
  });

  ipcMain.handle("euer:categories", () => listEuerCategories(db));
  ipcMain.handle("expenses:create", (_e, input: ExpenseInput) => createExpense(db, input));
  ipcMain.handle("expenses:get", (_e, id: number) => getExpense(db, id));
  ipcMain.handle("expenses:update", (_e, id: number, input: ExpenseInput) =>
    updateExpense(db, id, input),
  );
  ipcMain.handle("expenses:list", (_e, year: number) => listExpenses(db, year));
  ipcMain.handle("euer:report", (_e, year: number) => euerReport(db, year));
  ipcMain.handle("euer:years", () => listEuerYears(db));

  ipcMain.handle("gobd:report", () => verifyGobd(db, fileSha256));
  ipcMain.handle("gobd:quick", () => quickCheckGobd(db));

  ipcMain.handle("journal:list", () => listJournal(db));
  ipcMain.handle("journal:forInvoice", (_e, invoiceId: number) =>
    listJournalForInvoice(db, invoiceId),
  );
  ipcMain.handle("journal:export", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(win!, {
      title: "Journal exportieren",
      defaultPath: `GoBDesk-Journal-${stamp}.csv`,
      filters: [
        { name: "CSV (Excel)", extensions: ["csv"] },
        { name: "JSON", extensions: ["json"] },
      ],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const entries = listJournal(db);
    const isJson = res.filePath.toLowerCase().endsWith(".json");
    const content = isJson ? journalToJson(entries) : CSV_BOM + journalToCsv(entries);
    writeFileSync(res.filePath, content, "utf8");
    return { ok: true, path: res.filePath, count: entries.length };
  });

  ipcMain.handle("verfdok:getTexts", () => getVerfdokTexts(db));

  ipcMain.handle(
    "verfdok:export",
    async (_event, format: "pdf" | "md", texts: Record<string, string>) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const stamp = new Date().toISOString().slice(0, 10);
      const isPdf = format === "pdf";
      const res = await dialog.showSaveDialog(win!, {
        title: "Verfahrensdokumentation exportieren",
        defaultPath: `Verfahrensdokumentation-${stamp}.${isPdf ? "pdf" : "md"}`,
        filters: [isPdf ? { name: "PDF", extensions: ["pdf"] } : { name: "Markdown", extensions: ["md"] }],
      });
      if (res.canceled || !res.filePath) return { ok: false, canceled: true };

      // Angaben für den nächsten Export vorhalten und direkt ins Dokument einsetzen.
      saveVerfdokTexts(db, texts ?? {});
      const md = generateVerfahrensdok(db);
      const content = isPdf ? await htmlToPdf(renderVerfdokHtml(md)) : md;
      if (typeof content === "string") writeFileSync(res.filePath, content, "utf8");
      else writeFileSync(res.filePath, content);

      // Exportierte Fassung in der Hash-Kette verankern (Versionierungsnachweis).
      appendAudit(db, "verfdok", 0, "EXPORT", {
        format,
        file: path.basename(res.filePath),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
      return { ok: true, path: res.filePath };
    },
  );

  ipcMain.handle("gobd:exportZ3", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const pick = await dialog.showOpenDialog(win!, {
      title: "Zielordner für den Datenexport (Z3) wählen",
      properties: ["openDirectory", "createDirectory"],
    });
    if (pick.canceled || pick.filePaths.length === 0) return { ok: false, canceled: true };
    const res = exportZ3(db, pick.filePaths[0]);
    return { ok: true, path: res.path, files: res.files };
  });

  ipcMain.handle("config:get", () => ({
    dataDir: getDataDir(),
    defaultDir: getDefaultDataDir(),
    isCustom: isCustomDataDir(),
    dbPath: path.join(getDataDir(), DB_FILENAME),
    lastBackupAt: getLastBackupAt(),
  }));

  ipcMain.handle("config:openDataDir", () => shell.openPath(getDataDir()));

  ipcMain.handle("config:changeDataDir", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const pick = await dialog.showOpenDialog(win!, {
      title: "Neuen Speicherort wählen",
      properties: ["openDirectory", "createDirectory"],
    });
    if (pick.canceled || pick.filePaths.length === 0) return { moved: false };

    await moveDataDir(db, pick.filePaths[0]!); // konsistente Kopie, danach Neustart
    app.relaunch();
    app.exit(0);
    return { moved: true, dir: pick.filePaths[0] };
  });

  ipcMain.handle("backup:create", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const pick = await dialog.showOpenDialog(win!, {
      title: "Zielordner für die Sicherung wählen",
      properties: ["openDirectory", "createDirectory"],
    });
    if (pick.canceled || pick.filePaths.length === 0) return { ok: false, canceled: true };

    const res = await createBackup(db, pick.filePaths[0]!);
    await shell.openPath(res.path);
    return { ok: true, ...res };
  });

  const importFiles = async (files: string[], orderId?: number | null) => {
    let imported = 0;
    let duplicates = 0;
    for (const file of files) {
      const res = await importDocumentWithOcr(db, file, paths.sidecarDir);
      if (res.duplicate) duplicates += 1;
      else {
        imported += 1;
        if (orderId != null) setDocumentOrder(db, res.id, orderId);
      }
    }
    return { imported, duplicates };
  };

  const pickDocuments = async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return dialog.showOpenDialog(win!, {
      title: "Dokumente importieren",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Dokumente",
          extensions: ["pdf", "png", "jpg", "jpeg", "gif", "webp", "txt", "xml", "doc", "docx"],
        },
        { name: "Alle Dateien", extensions: ["*"] },
      ],
    });
  };

  ipcMain.handle("documents:import", async () => {
    const pick = await pickDocuments();
    if (pick.canceled || pick.filePaths.length === 0) {
      return { imported: 0, duplicates: 0, canceled: true };
    }
    return importFiles(pick.filePaths);
  });

  ipcMain.handle("documents:importForOrder", async (_e, orderId: number) => {
    const pick = await pickDocuments();
    if (pick.canceled || pick.filePaths.length === 0) {
      return { imported: 0, duplicates: 0, canceled: true };
    }
    return importFiles(pick.filePaths, orderId);
  });

  ipcMain.handle("documents:importPaths", (_e, filePaths: string[]) =>
    importFiles(Array.isArray(filePaths) ? filePaths : []),
  );

  ipcMain.handle("documents:list", (_e, filter?: DocumentFilter) => listDocuments(db, filter));
  ipcMain.handle("documents:get", (_e, id: number) => getDocument(db, id));
  ipcMain.handle("documents:update", (_e, id: number, input: DocumentUpdateInput) =>
    updateDocument(db, id, input),
  );
  ipcMain.handle("documents:updateOcr", (_e, id: number, text: string) =>
    updateDocumentOcr(db, id, text),
  );
  ipcMain.handle("documents:archive", (_e, id: number, archived: boolean) =>
    archiveDocument(db, id, archived),
  );
  ipcMain.handle("documents:delete", (_e, id: number) => deleteDocument(db, id));
  ipcMain.handle("documents:open", async (_e, id: number) => {
    const p = documentPath(db, id);
    if (p) await shell.openPath(p);
  });
  ipcMain.handle("documents:types", () => listDocumentTypes(db));
  ipcMain.handle("documents:tags", () => listTags(db));
  ipcMain.handle(
    "documents:link",
    (_e, documentId: number, targetType: DocumentTargetType, targetId: number) =>
      linkDocument(db, documentId, targetType, targetId),
  );
  ipcMain.handle("documents:unlink", (_e, linkId: number) => unlinkDocument(db, linkId));
  ipcMain.handle("documents:linkTargets", () => listLinkTargets(db));
  ipcMain.handle(
    "documents:forTarget",
    (_e, targetType: DocumentTargetType, targetId: number) =>
      listDocumentsForTarget(db, targetType, targetId),
  );

  ipcMain.handle("orders:list", (_e, filter?: OrderFilter) => listOrders(db, filter));
  ipcMain.handle("orders:get", (_e, id: number) => getOrder(db, id));
  ipcMain.handle("orders:create", (_e, input: OrderInput) => createOrder(db, input));
  ipcMain.handle("orders:update", (_e, id: number, input: OrderInput) => updateOrder(db, id, input));
  ipcMain.handle("orders:delete", (_e, id: number) => deleteOrder(db, id));
  ipcMain.handle("orders:options", () => listOrderOptions(db));
  ipcMain.handle("orders:suggestNumber", () => suggestOrderNumber(db));

  ipcMain.handle("app:info", () => getAppInfo());
  ipcMain.handle("app:checkUpdate", () => checkForUpdate());
  ipcMain.handle("app:openExternal", (_e, url: string) => {
    // Nur http(s)-Links zulassen – keine file:/-, javascript:- o. Ä. Schemata.
    if (typeof url === "string" && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
}
