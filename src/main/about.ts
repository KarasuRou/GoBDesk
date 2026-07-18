/**
 * App-Metadaten (Herkunft, Lizenz), Öffnen der Open-Source-Hinweise und eine
 * offline-tolerante Update-Prüfung gegen die neueste GitHub-Release-Version.
 */

import { app } from "electron";

import type { AppInfo, UpdateCheckResult } from "../shared/api.js";

const REPO_URL = "https://github.com/KarasuRou/GoBDesk";
const RELEASE_API = "https://api.github.com/repos/KarasuRou/GoBDesk/releases/latest";
const UPDATE_TIMEOUT_MS = 8000;

export function getAppInfo(): AppInfo {
  return {
    name: "GoBDesk",
    version: app.getVersion(),
    author: "Rouven Tjalf Rosploch",
    license: "MIT",
    repository: REPO_URL,
    copyrightYear: 2026,
  };
}

/** SemVer-Vergleich ohne Abhängigkeit: true, wenn `a` neuer als `b` ist. */
function isNewer(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.replace(/^v/i, "").split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * Fragt die neueste veröffentlichte Version bei GitHub ab. Bewusst fehlertolerant:
 * ohne Internet, ohne Release oder bei API-Fehlern wird kein Alarm ausgelöst.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = app.getVersion();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPDATE_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "GoBDesk" },
      signal: controller.signal,
    });
    // 404 = noch kein Release veröffentlicht → kein Fehler, gilt als „aktuell".
    if (res.status === 404) return { ok: true, currentVersion, updateAvailable: false };
    if (!res.ok) return { ok: false, currentVersion, error: `GitHub antwortete mit ${res.status}.` };

    const data = (await res.json()) as { tag_name?: string; html_url?: string };
    const latestVersion = (data.tag_name ?? "").replace(/^v/i, "");
    if (!latestVersion) return { ok: true, currentVersion, updateAvailable: false };

    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: isNewer(latestVersion, currentVersion),
      releaseUrl: data.html_url ?? `${REPO_URL}/releases/latest`,
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      currentVersion,
      error: aborted
        ? "Zeitüberschreitung – keine Internetverbindung?"
        : "Update-Prüfung nicht möglich (offline?).",
    };
  } finally {
    clearTimeout(timer);
  }
}
