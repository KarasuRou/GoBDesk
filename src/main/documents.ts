/** Dokumentenmanagement (Phase 7, DMS): Import, Metadaten, Tags, Volltextsuche. */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import type {
  DocumentDetail,
  DocumentFilter,
  DocumentImportResult,
  DocumentLink,
  DocumentListItem,
  DocumentTargetType,
  DocumentType,
  DocumentUpdateInput,
  LinkTargets,
  Tag,
} from "../shared/api.js";
import { appendAudit } from "../core/gobd.js";
import { getDataDir } from "./config.js";
import { fileSha256 } from "./hash.js";
import { extractText, readInboundEInvoice } from "./sidecar.js";

const LIST_COLUMNS = `
  d.id, d.title, d.doc_date, d.original_filename, d.file_size, d.added_at, d.is_archived,
  dt.name AS type_name, c.company_name AS customer_name,
  (SELECT GROUP_CONCAT(t.name, ', ')
     FROM document_tags x JOIN tags t ON t.id = x.tag_id
    WHERE x.document_id = d.id) AS tags`;

const LIST_JOINS = `
  LEFT JOIN document_types dt ON dt.id = d.document_type_id
  LEFT JOIN customers c ON c.id = d.customer_id`;

const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function documentsDir(): string {
  return path.join(getDataDir(), "documents");
}

/** Baut eine FTS5-Abfrage (alle Wörter als Präfix-AND). Leer -> null. */
function ftsMatch(search: string): string | null {
  const terms = search
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`);
  return terms.length ? terms.join(" ") : null;
}

/**
 * Importiert eine Datei in die verwaltete, hash-basierte Ablage
 * (`<Datenordner>/documents/<xx>/<sha256>.<ext>`). Dubletten (gleicher Inhalt)
 * werden erkannt und nicht doppelt abgelegt.
 */
export function importDocument(db: Database.Database, sourcePath: string): DocumentImportResult {
  if (!existsSync(sourcePath)) throw new Error(`Datei nicht gefunden: ${sourcePath}`);

  const sha = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
  const existing = db.prepare("SELECT id FROM documents WHERE content_sha256 = ?").get(sha) as
    | { id: number }
    | undefined;
  if (existing) return { id: existing.id, duplicate: true };

  const ext = path.extname(sourcePath).toLowerCase();
  const targetDir = path.join(documentsDir(), sha.slice(0, 2));
  mkdirSync(targetDir, { recursive: true });
  const stored = path.join(targetDir, sha + ext);
  if (!existsSync(stored)) {
    copyFileSync(sourcePath, stored);
    // Kopie byte-genau verifizieren, bevor der Datensatz entsteht (Belegsicherung).
    if (fileSha256(stored) !== sha) {
      try {
        rmSync(stored);
      } catch {
        /* defekte Kopie bleibt notfalls liegen, Datensatz entsteht nicht */
      }
      throw new Error("Die Datei konnte nicht fehlerfrei in die Ablage kopiert werden.");
    }
  }

  const title = path.basename(sourcePath, ext);
  const run = db.transaction((): number => {
    const info = db
      .prepare(
        `INSERT INTO documents (title, original_filename, stored_path, content_sha256, mime_type, file_size)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title,
        path.basename(sourcePath),
        stored,
        sha,
        MIME[ext] ?? "application/octet-stream",
        statSync(stored).size,
      );
    const id = Number(info.lastInsertRowid);
    // Eingang elektronischer Unterlagen protokollieren (GoBD Rz. 117) und den
    // Datei-Soll-Hash revisionssicher im Journal verankern.
    appendAudit(db, "document", id, "IMPORT", {
      title,
      original_filename: path.basename(sourcePath),
      sha256: sha,
    });
    return id;
  });
  return { id: run(), duplicate: false };
}

/** Speichert den extrahierten Volltext (aktualisiert per Trigger auch die FTS-Tabelle). */
export function setOcrText(db: Database.Database, id: number, text: string): void {
  db.prepare("UPDATE documents SET ocr_text = ? WHERE id = ?").run(text, id);
}

/**
 * Importiert eine Datei, extrahiert (best effort) ihren Text für die
 * Volltextsuche und erkennt empfangene E-Rechnungen (ZUGFeRD/XRechnung) –
 * deren Kerndaten werden für die Übernahme als Ausgabe am Dokument gecacht.
 * Fehler bei der Anreicherung sind unkritisch, das Original bleibt maßgeblich.
 */
export async function importDocumentWithOcr(
  db: Database.Database,
  sourcePath: string,
  sidecarDir: string,
): Promise<DocumentImportResult> {
  const res = importDocument(db, sourcePath);
  if (!res.duplicate) {
    try {
      const text = await extractText(sourcePath, sidecarDir);
      if (text.trim()) setOcrText(db, res.id, text);
    } catch {
      /* Extraktion ist optional */
    }
    const ext = path.extname(sourcePath).toLowerCase();
    if (ext === ".pdf" || ext === ".xml") {
      try {
        const inv = await readInboundEInvoice(sourcePath, sidecarDir);
        if (inv.ok && inv.is_einvoice && inv.data) {
          db.prepare("UPDATE documents SET einvoice_json = ? WHERE id = ?").run(
            JSON.stringify(inv.data),
            res.id,
          );
        }
      } catch {
        /* E-Rechnungs-Erkennung ist optional */
      }
    }
  }
  return res;
}

export function listDocuments(db: Database.Database, filter: DocumentFilter = {}): DocumentListItem[] {
  const where = filter.includeArchived ? ["1 = 1"] : ["d.is_archived = 0"];
  const params: Record<string, unknown> = {};

  const match = ftsMatch(filter.search ?? "");
  if (match) {
    where.push("d.id IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH @match)");
    params.match = match;
  }
  if (filter.typeId != null) {
    where.push("d.document_type_id = @typeId");
    params.typeId = filter.typeId;
  }
  if (filter.customerId != null) {
    where.push("d.customer_id = @customerId");
    params.customerId = filter.customerId;
  }
  if (filter.orderId != null) {
    where.push("d.order_id = @orderId");
    params.orderId = filter.orderId;
  }

  const stmt = db.prepare(
    `SELECT ${LIST_COLUMNS} FROM documents d ${LIST_JOINS}
      WHERE ${where.join(" AND ")} ORDER BY d.added_at DESC`,
  );
  return (Object.keys(params).length ? stmt.all(params) : stmt.all()) as DocumentListItem[];
}

export function getDocument(db: Database.Database, id: number): DocumentDetail | null {
  const row = db
    .prepare(
      `SELECT d.id, d.title, d.original_filename, d.mime_type, d.file_size,
              d.document_type_id, d.customer_id, d.order_id, d.doc_date, d.added_at,
              d.is_archived, d.ocr_text, d.einvoice_json,
              dt.name AS type_name, c.company_name AS customer_name, o.order_number
         FROM documents d
         LEFT JOIN document_types dt ON dt.id = d.document_type_id
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN orders o ON o.id = d.order_id
        WHERE d.id = ?`,
    )
    .get(id) as (Omit<DocumentDetail, "tags" | "links" | "einvoice"> & { einvoice_json: string | null }) | undefined;
  if (!row) return null;

  const tags = (
    db
      .prepare(
        `SELECT t.name FROM document_tags x JOIN tags t ON t.id = x.tag_id
          WHERE x.document_id = ? ORDER BY t.name`,
      )
      .all(id) as Array<{ name: string }>
  ).map((r) => r.name);
  const { einvoice_json, ...rest } = row;
  let einvoice: DocumentDetail["einvoice"] = null;
  if (einvoice_json) {
    try {
      einvoice = JSON.parse(einvoice_json) as DocumentDetail["einvoice"];
    } catch {
      /* defekter Cache -> kein Komfort-Feature, Original bleibt maßgeblich */
    }
  }
  return { ...rest, einvoice, tags, links: getDocumentLinks(db, id) };
}

/** Verknüpfungen eines Dokuments mit sprechendem Label je Ziel (polymorph). */
export function getDocumentLinks(db: Database.Database, documentId: number): DocumentLink[] {
  return db
    .prepare(
      `SELECT l.id, l.target_type, l.target_id,
              CASE l.target_type
                WHEN 'invoice'  THEN COALESCE((SELECT invoice_number FROM invoices WHERE id = l.target_id), 'Entwurf #' || l.target_id)
                WHEN 'expense'  THEN (SELECT description FROM expenses WHERE id = l.target_id)
                WHEN 'customer' THEN (SELECT company_name FROM customers WHERE id = l.target_id)
              END AS label
         FROM document_links l
        WHERE l.document_id = ?
        ORDER BY l.target_type, l.id`,
    )
    .all(documentId) as DocumentLink[];
}

export function linkDocument(
  db: Database.Database,
  documentId: number,
  targetType: DocumentTargetType,
  targetId: number,
): void {
  if (!["customer", "invoice", "expense"].includes(targetType)) {
    throw new Error("Ungültiger Verknüpfungstyp.");
  }
  db.prepare(
    "INSERT OR IGNORE INTO document_links (document_id, target_type, target_id) VALUES (?, ?, ?)",
  ).run(documentId, targetType, targetId);
}

export function unlinkDocument(db: Database.Database, linkId: number): void {
  db.prepare("DELETE FROM document_links WHERE id = ?").run(linkId);
}

/** Auswahlmöglichkeiten für neue Verknüpfungen (Rechnungen + Ausgaben). */
export function listLinkTargets(db: Database.Database): LinkTargets {
  const invoices = db
    .prepare(
      `SELECT id, COALESCE(invoice_number, 'Entwurf #' || id) AS label FROM invoices ORDER BY id DESC`,
    )
    .all() as LinkTargets["invoices"];
  const expenses = db
    .prepare(
      `SELECT id, description || ' (' || COALESCE(payment_date, expense_date) || ')' AS label
         FROM expenses ORDER BY id DESC`,
    )
    .all() as LinkTargets["expenses"];
  return { invoices, expenses };
}

/** Dokumente, die an ein Ziel hängen (Kunde über customer_id, sonst document_links). */
export function listDocumentsForTarget(
  db: Database.Database,
  targetType: DocumentTargetType,
  targetId: number,
): DocumentListItem[] {
  if (targetType === "customer") {
    return db
      .prepare(
        `SELECT ${LIST_COLUMNS} FROM documents d ${LIST_JOINS}
          WHERE d.customer_id = ? ORDER BY d.added_at DESC`,
      )
      .all(targetId) as DocumentListItem[];
  }
  return db
    .prepare(
      `SELECT ${LIST_COLUMNS} FROM documents d
         JOIN document_links l ON l.document_id = d.id ${LIST_JOINS}
        WHERE l.target_type = ? AND l.target_id = ? ORDER BY d.added_at DESC`,
    )
    .all(targetType, targetId) as DocumentListItem[];
}

/** Aktualisiert Metadaten + Tags eines Dokuments (Tags werden bei Bedarf angelegt). */
export function updateDocument(
  db: Database.Database,
  id: number,
  input: DocumentUpdateInput,
): void {
  const title = input.title.trim();
  if (title.length === 0) throw new Error("Bitte einen Titel angeben.");

  const run = db.transaction(() => {
    // Bearbeitungsvorgänge an aufbewahrten Unterlagen protokollieren (Rz. 123).
    const before = db
      .prepare(
        "SELECT title, document_type_id, customer_id, order_id, doc_date FROM documents WHERE id = ?",
      )
      .get(id) as Record<string, unknown> | undefined;
    db.prepare(
      `UPDATE documents SET title = ?, document_type_id = ?, customer_id = ?, order_id = ?, doc_date = ?
        WHERE id = ?`,
    ).run(
      title,
      input.document_type_id ?? null,
      input.customer_id ?? null,
      input.order_id ?? null,
      input.doc_date?.trim() || null,
      id,
    );

    db.prepare("DELETE FROM document_tags WHERE document_id = ?").run(id);
    const ensureTag = db.prepare(
      "INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING id",
    );
    const link = db.prepare("INSERT OR IGNORE INTO document_tags (document_id, tag_id) VALUES (?, ?)");
    for (const raw of input.tags) {
      const name = raw.trim();
      if (!name) continue;
      link.run(id, (ensureTag.get(name) as { id: number }).id);
    }
    appendAudit(db, "document", id, "UPDATE", {
      title,
      document_type_id: input.document_type_id ?? null,
      customer_id: input.customer_id ?? null,
      order_id: input.order_id ?? null,
      doc_date: input.doc_date?.trim() || null,
      tags: input.tags,
      before,
    });
  });
  run();
}

/** Korrigiert den OCR-Volltext (GoBD Rz. 130/131: „nach Verifikation und Korrektur").
 * Die FTS-Tabelle wird per Trigger aktualisiert; die Korrektur wird journalisiert. */
export function updateDocumentOcr(db: Database.Database, id: number, text: string): void {
  const run = db.transaction(() => {
    const before = db.prepare("SELECT title, ocr_text FROM documents WHERE id = ?").get(id) as
      | { title: string; ocr_text: string | null }
      | undefined;
    if (!before) throw new Error("Dokument nicht gefunden.");
    db.prepare("UPDATE documents SET ocr_text = ? WHERE id = ?").run(text, id);
    appendAudit(db, "document", id, "OCR", {
      title: before.title,
      before_sha256: createHash("sha256").update(before.ocr_text ?? "", "utf8").digest("hex"),
      after_sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      after_length: text.length,
    });
  });
  run();
}

/** Archiviert ein Dokument bzw. holt es zurück – der GoBD-konforme Weg statt Löschen. */
export function archiveDocument(db: Database.Database, id: number, archived: boolean): void {
  const run = db.transaction(() => {
    const row = db.prepare("SELECT title, is_archived FROM documents WHERE id = ?").get(id) as
      | { title: string; is_archived: number }
      | undefined;
    if (!row) throw new Error("Dokument nicht gefunden.");
    if (row.is_archived === (archived ? 1 : 0)) return;
    db.prepare("UPDATE documents SET is_archived = ? WHERE id = ?").run(archived ? 1 : 0, id);
    appendAudit(db, "document", id, archived ? "ARCHIVE" : "RESTORE", { title: row.title });
  });
  run();
}

/** Verknüpfungen, die ein Dokument als aufbewahrungspflichtigen Beleg ausweisen. */
function documentUsage(db: Database.Database, id: number): string[] {
  const usage: string[] = [];
  const doc = db.prepare("SELECT customer_id, order_id FROM documents WHERE id = ?").get(id) as
    | { customer_id: number | null; order_id: number | null }
    | undefined;
  if (!doc) return usage;
  if (doc.customer_id != null) usage.push("einem Kunden zugeordnet");
  if (doc.order_id != null) usage.push("einem Auftrag zugeordnet");
  const links = (
    db.prepare("SELECT COUNT(*) AS n FROM document_links WHERE document_id = ?").get(id) as {
      n: number;
    }
  ).n;
  if (links > 0) usage.push(`mit ${links} Beleg(en) verknüpft`);
  const expenseRefs = (
    db.prepare("SELECT COUNT(*) AS n FROM expenses WHERE document_id = ?").get(id) as { n: number }
  ).n;
  if (expenseRefs > 0) usage.push("als Ausgabenbeleg hinterlegt");
  return usage;
}

/**
 * Löscht ein Dokument endgültig – nur zulässig, wenn es nicht als Beleg
 * verknüpft ist (GoBD Rz. 119: aufbewahrungspflichtige Unterlagen dürfen vor
 * Fristablauf nicht gelöscht werden; verknüpfte Dokumente nur archivieren).
 * Die Löschung selbst wird journalisiert.
 */
export function deleteDocument(db: Database.Database, id: number): void {
  const row = db
    .prepare("SELECT title, stored_path, content_sha256 FROM documents WHERE id = ?")
    .get(id) as { title: string; stored_path: string; content_sha256: string } | undefined;
  if (!row) return;

  const usage = documentUsage(db, id);
  if (usage.length > 0) {
    throw new Error(
      `Dokument ist ${usage.join(", ")} und kann als Beleg nicht gelöscht werden – bitte stattdessen archivieren.`,
    );
  }

  const run = db.transaction(() => {
    db.prepare("DELETE FROM documents WHERE id = ?").run(id); // FK-Cascade + FTS-Trigger
    appendAudit(db, "document", id, "DELETE", { title: row.title, sha256: row.content_sha256 });
  });
  run();
  if (row.stored_path && existsSync(row.stored_path)) {
    try {
      rmSync(row.stored_path);
    } catch {
      /* verwaiste Datei ist unkritisch */
    }
  }
}

export function documentPath(db: Database.Database, id: number): string | null {
  const row = db.prepare("SELECT stored_path FROM documents WHERE id = ?").get(id) as
    | { stored_path: string }
    | undefined;
  return row?.stored_path ?? null;
}

export function setDocumentOrder(db: Database.Database, id: number, orderId: number | null): void {
  const run = db.transaction(() => {
    const before = db.prepare("SELECT title, order_id FROM documents WHERE id = ?").get(id) as
      | { title: string; order_id: number | null }
      | undefined;
    if (!before || before.order_id === orderId) return;
    db.prepare("UPDATE documents SET order_id = ? WHERE id = ?").run(orderId, id);
    appendAudit(db, "document", id, "UPDATE", {
      title: before.title,
      order_id: orderId,
      before: { order_id: before.order_id },
    });
  });
  run();
}

export function listDocumentsForOrder(db: Database.Database, orderId: number): DocumentListItem[] {
  return db
    .prepare(
      `SELECT ${LIST_COLUMNS} FROM documents d ${LIST_JOINS}
        WHERE d.order_id = ? ORDER BY d.added_at DESC`,
    )
    .all(orderId) as DocumentListItem[];
}

export function listDocumentTypes(db: Database.Database): DocumentType[] {
  return db.prepare("SELECT id, name FROM document_types ORDER BY id").all() as DocumentType[];
}

export function listTags(db: Database.Database): Tag[] {
  return db.prepare("SELECT id, name, color FROM tags ORDER BY name").all() as Tag[];
}
