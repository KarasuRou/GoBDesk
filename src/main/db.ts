/** DB-Initialisierung für den Main-Prozess: Pfad im Nutzer-Datenverzeichnis. */

import path from "node:path";

import { app } from "electron";
import type Database from "better-sqlite3";

import { openDatabase } from "../db/database.js";
import { getDataDir } from "./config.js";
import { seedDefaults } from "./repository.js";
import { DB_FILENAME } from "./storage.js";

export function initDatabase(): Database.Database {
  // GOBDESK_DB erlaubt einen abweichenden Pfad (z. B. für Tests/Smoke),
  // sonst der konfigurierte Datenspeicherort (Standard: userData).
  const dbFile = process.env["GOBDESK_DB"] ?? path.join(getDataDir(), DB_FILENAME);
  // Migrationen liegen relativ zum App-Root (Packaging: in der asar).
  const migrationsDir = path.join(app.getAppPath(), "db", "migrations");
  const db = openDatabase(dbFile, migrationsDir);
  seedDefaults(db);
  return db;
}
