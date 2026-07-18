/** SHA-256-Helfer für die byte-genaue Integritätsprüfung von Rechnungsdateien. */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Hex-SHA-256 einer Datei bzw. null, wenn sie nicht gelesen werden kann (fehlt). */
export function fileSha256(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

/** SHA-256 + Byte-Größe einer existierenden Datei (wirft, falls nicht lesbar). */
export function fileDigest(path: string): { sha256: string; bytes: number } {
  const buf = readFileSync(path);
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}
