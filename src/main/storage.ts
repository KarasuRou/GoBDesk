/**
 * Datenspeicher-Operationen: Speicherort verschieben und Backup/Snapshot erzeugen.
 */

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app } from "electron";
import Database from "better-sqlite3";

import { appendAudit, verifyAuditChain } from "../core/gobd.js";
import { getDataDir, setDataDir, setLastBackupAt } from "./config.js";

export const DB_FILENAME = "gobdesk.sqlite";
const INVOICES_SUBDIR = "invoices";
const DOCUMENTS_SUBDIR = "documents";

export interface BackupResult {
  path: string;
  auditOk: boolean;
  sizeBytes: number;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

/**
 * Erzeugt einen konsistenten Snapshot (GoBD-Sicherung) in einem neuen Unterordner
 * des Zielverzeichnisses: Online-Backup der DB + Kopie der Rechnungs-PDFs/-XMLs +
 * Manifest mit SHA-256 und Prüfergebnis der Audit-Kette. Dateien werden
 * schreibgeschützt gesetzt (unveränderbarer Snapshot).
 */
export async function createBackup(
  db: Database.Database,
  destParent: string,
): Promise<BackupResult> {
  const dir = path.join(destParent, `GoBDesk-Backup-${timestamp()}`);
  mkdirSync(dir, { recursive: true });

  const dbCopy = path.join(dir, DB_FILENAME);
  await db.backup(dbCopy); // konsistent trotz WAL

  for (const sub of [INVOICES_SUBDIR, DOCUMENTS_SUBDIR]) {
    const src = path.join(getDataDir(), sub);
    if (existsSync(src)) cpSync(src, path.join(dir, sub), { recursive: true });
  }

  const bytes = readFileSync(dbCopy);
  const auditOk = verifyAuditChain(db) === null;
  const manifest = {
    app: "GoBDesk",
    version: app.getVersion(),
    created_at: new Date().toISOString(),
    audit_chain_ok: auditOk,
    database: { file: DB_FILENAME, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  try {
    chmodSync(dbCopy, 0o444);
    chmodSync(manifestPath, 0o444);
  } catch {
    /* Schreibschutz ist best effort (Windows-ACLs) */
  }

  // IKS-Nachweis (GoBD Rz. 100 ff.): jede Sicherung wird mit Ziel, Größe und
  // DB-Prüfsumme in der Hash-Kette verankert (Beleg für die Verfahrensdok).
  appendAudit(db, "backup", 0, "CREATE", {
    path: dir,
    db_sha256: manifest.database.sha256,
    db_bytes: bytes.length,
    audit_chain_ok: auditOk,
  });

  setLastBackupAt(new Date().toISOString());
  return { path: dir, auditOk, sizeBytes: bytes.length };
}

/**
 * Verschiebt den Datenspeicher an einen neuen Ort: konsistente DB-Kopie (ohne die
 * laufende Verbindung zu schließen) + Kopie des Rechnungsordners, danach die
 * absoluten Artefaktpfade in der neuen DB auf den neuen Ort umgeschrieben und der
 * Speicherort persistiert. Schlägt ein Schritt fehl, bleibt die App über die alte
 * Verbindung funktionsfähig. Die alten Dateien bleiben als Sicherheit erhalten.
 * Der Aufrufer startet die App anschließend neu.
 */
export async function moveDataDir(db: Database.Database, newDir: string): Promise<void> {
  const oldDir = getDataDir();
  if (path.resolve(newDir) === path.resolve(oldDir)) return;
  if (existsSync(path.join(newDir, DB_FILENAME))) {
    throw new Error("Der Zielordner enthält bereits GoBDesk-Daten.");
  }

  mkdirSync(newDir, { recursive: true });
  await db.backup(path.join(newDir, DB_FILENAME)); // konsistent trotz WAL

  const newInvoices = path.join(newDir, INVOICES_SUBDIR);
  const oldInvoices = path.join(oldDir, INVOICES_SUBDIR);
  if (existsSync(oldInvoices)) cpSync(oldInvoices, newInvoices, { recursive: true });

  const newDocuments = path.join(newDir, DOCUMENTS_SUBDIR);
  const oldDocuments = path.join(oldDir, DOCUMENTS_SUBDIR);
  if (existsSync(oldDocuments)) cpSync(oldDocuments, newDocuments, { recursive: true });

  // Absolute Datei-Pfade in der neuen DB auf den neuen Ort umschreiben.
  const ndb = new Database(path.join(newDir, DB_FILENAME));
  try {
    const rewrite = ndb.transaction(() => {
      const artifacts = ndb.prepare("SELECT id, path FROM invoice_artifacts").all() as Array<{
        id: number;
        path: string;
      }>;
      const updArtifact = ndb.prepare("UPDATE invoice_artifacts SET path = ? WHERE id = ?");
      for (const r of artifacts) updArtifact.run(path.join(newInvoices, path.basename(r.path)), r.id);

      const docs = ndb.prepare("SELECT id, stored_path FROM documents").all() as Array<{
        id: number;
        stored_path: string;
      }>;
      const updDoc = ndb.prepare("UPDATE documents SET stored_path = ? WHERE id = ?");
      for (const r of docs) {
        // Relativen Pfad ab dem Dokumentordner erhalten (Hash-Unterordner-Struktur).
        updDoc.run(path.join(newDocuments, path.relative(oldDocuments, r.stored_path)), r.id);
      }
    });
    rewrite();
  } finally {
    ndb.close();
  }

  setDataDir(newDir);
}
