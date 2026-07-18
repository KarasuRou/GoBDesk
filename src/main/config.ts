/**
 * App-Konfiguration außerhalb der Datenbank (z. B. der Datenspeicherort).
 *
 * Liegt als `config.json` im Standard-userData-Verzeichnis und wird beim Start
 * gelesen – der Speicherort muss bekannt sein, *bevor* die DB geöffnet wird,
 * kann also nicht in der DB selbst stehen.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

interface AppConfig {
  dataDir?: string;
  lastBackupAt?: string;
}

function configPath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

function read(): AppConfig {
  try {
    if (existsSync(configPath())) {
      return JSON.parse(readFileSync(configPath(), "utf8")) as AppConfig;
    }
  } catch {
    /* defektes Config-File ignorieren und auf Standard zurückfallen */
  }
  return {};
}

/** Standard-Datenverzeichnis (userData), immer verfügbar. */
export function getDefaultDataDir(): string {
  return app.getPath("userData");
}

/** Aktueller Datenspeicherort (eigener Ordner falls konfiguriert, sonst userData). */
export function getDataDir(): string {
  const cfg = read();
  const dir = cfg.dataDir?.trim();
  if (dir && existsSync(dir)) return dir;
  return getDefaultDataDir();
}

export function isCustomDataDir(): boolean {
  return path.resolve(getDataDir()) !== path.resolve(getDefaultDataDir());
}

/** Persistiert den Datenspeicherort (null = zurück auf Standard). */
export function setDataDir(dir: string | null): void {
  const cfg = read();
  if (dir) cfg.dataDir = dir;
  else delete cfg.dataDir;
  write(cfg);
}

/** Zeitpunkt der letzten erfolgreichen Sicherung (für die IKS-Erinnerung). */
export function getLastBackupAt(): string | null {
  return read().lastBackupAt ?? null;
}

export function setLastBackupAt(iso: string): void {
  const cfg = read();
  cfg.lastBackupAt = iso;
  write(cfg);
}

function write(cfg: AppConfig): void {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), "utf8");
}
