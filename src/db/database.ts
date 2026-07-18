/**
 * SQLite-Zugriff via better-sqlite3: Verbindung, PRAGMAs und Migrations-Runner.
 * Die Migrationen liegen als .sql-Dateien unter db/migrations/.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../db/migrations", import.meta.url));

export function openDatabase(
  file: string,
  migrationsDir: string = MIGRATIONS_DIR,
): Database.Database {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db, migrationsDir);
  return db;
}

export function migrate(
  db: Database.Database,
  migrationsDir: string = MIGRATIONS_DIR,
): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const runMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
        file,
        new Date().toISOString(),
      );
    });
    runMigration();
  }
}
