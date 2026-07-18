/**
 * Laufzeitpfade für gebündelte Abhängigkeiten (Single-Exe-Ziel, Phase 8).
 *
 * Im Paket-Modus liegen Sidecar-Binary und Ghostscript unter `resources/`
 * (electron-builder `extraResources`). Diese Funktion verweist den Sidecar per
 * Umgebungsvariablen darauf; im Dev-Modus bleibt alles beim Systemverhalten
 * (`py -3.11`, Ghostscript aus PATH).
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

let sidecarDir = "";

/** Ermittelt die Laufzeitpfade und setzt die Sidecar-Umgebungsvariablen. */
export function configureRuntime(): void {
  if (!app.isPackaged) {
    sidecarDir = path.join(app.getAppPath(), "sidecar");
    return;
  }

  const resources = process.resourcesPath;
  sidecarDir = path.join(resources, "sidecar");

  const sidecarBin = path.join(sidecarDir, "einvoice.exe");
  if (existsSync(sidecarBin)) process.env["GOBDESK_SIDECAR_BIN"] = sidecarBin;

  const gs = path.join(resources, "ghostscript", "bin", "gswin64c.exe");
  if (existsSync(gs)) {
    process.env["GOBDESK_GS"] = gs;
    const icc = path.join(resources, "ghostscript", "iccprofiles", "srgb.icc");
    if (existsSync(icc)) process.env["GOBDESK_GS_ICC"] = icc;
  }

  // Tesseract ist optional gebündelt (Scan-OCR); fehlt es, bleibt die digitale
  // PDF-Textextraktion (pypdf) unberührt.
  const tesseract = path.join(resources, "tesseract", "tesseract.exe");
  if (existsSync(tesseract)) {
    process.env["GOBDESK_TESSERACT"] = tesseract;
    const tessdata = path.join(resources, "tesseract", "tessdata");
    if (existsSync(tessdata)) process.env["TESSDATA_PREFIX"] = tessdata;
  }
}

/** Arbeitsverzeichnis des Sidecars (Dev: Projekt-`sidecar/`, Paket: `resources/sidecar/`). */
export function getSidecarDir(): string {
  return sidecarDir || path.join(app.getAppPath(), "sidecar");
}
