/**
 * Staging der Laufzeit-Abhängigkeiten für electron-builder (Phase 8, Single-Exe).
 *
 * Kopiert das PyInstaller-Sidecar-Bundle und eine schlanke Ghostscript-Laufzeit
 * nach build/bundle/. Von dort übernimmt electron-builder sie als extraResources
 * (siehe electron-builder.yml). So braucht der Endanwender weder Python noch eine
 * separate Ghostscript-Installation.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(root, "build", "bundle");

function stageSidecar() {
  const dist = path.join(root, "sidecar", "dist", "einvoice");
  if (!existsSync(path.join(dist, "einvoice.exe"))) {
    throw new Error("Sidecar-Binary fehlt – zuerst `npm run bundle:sidecar` ausführen.");
  }
  const target = path.join(bundleDir, "sidecar");
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true });
  console.log("✓ Sidecar gebündelt →", path.relative(root, target));
}

function findGhostscript() {
  const base = "C:\\Program Files\\gs";
  if (!existsSync(base)) {
    throw new Error(`Ghostscript nicht gefunden (${base}).`);
  }
  const versions = readdirSync(base).sort();
  return path.join(base, versions[versions.length - 1]);
}

function stageGhostscript() {
  const gsRoot = findGhostscript();
  const target = path.join(bundleDir, "ghostscript");
  rmSync(target, { recursive: true, force: true });

  // Nur die Laufzeit-Bestandteile übernehmen (ohne doc/examples spart ~30 MB).
  mkdirSync(path.join(target, "bin"), { recursive: true });
  for (const file of ["gswin64c.exe", "gsdll64.dll"]) {
    cpSync(path.join(gsRoot, "bin", file), path.join(target, "bin", file));
  }
  for (const dir of ["lib", "Resource", "iccprofiles"]) {
    cpSync(path.join(gsRoot, dir), path.join(target, dir), { recursive: true });
  }
  console.log("✓ Ghostscript gebündelt →", path.relative(root, target), `(Quelle: ${gsRoot})`);
}

function findTesseract() {
  const candidates = [
    "C:\\Program Files\\Tesseract-OCR",
    "C:\\Program Files (x86)\\Tesseract-OCR",
  ];
  return candidates.find((c) => existsSync(path.join(c, "tesseract.exe"))) ?? null;
}

/**
 * Optional: Tesseract für Scan-OCR mitliefern. Fehlt es lokal, wird der Ordner leer
 * angelegt (electron-builder-`extraResources` braucht ihn) und Scan-OCR steht im
 * Paket nicht bereit – digitale PDFs bleiben über pypdf durchsuchbar.
 */
function stageTesseract() {
  const target = path.join(bundleDir, "tesseract");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  const rootDir = findTesseract();
  if (!rootDir) {
    console.warn("⚠ Tesseract nicht gefunden – Scan-OCR im Paket deaktiviert (digitale PDFs weiterhin durchsuchbar).");
    return;
  }

  // Nur die Laufzeit übernehmen: tesseract.exe + DLLs (keine Trainings-/Dev-Tools).
  for (const entry of readdirSync(rootDir)) {
    const src = path.join(rootDir, entry);
    const lower = entry.toLowerCase();
    if ((lower === "tesseract.exe" || lower.endsWith(".dll")) && statSync(src).isFile()) {
      cpSync(src, path.join(target, entry));
    }
  }
  // Nur die benötigten Sprachdaten (deu/eng/osd), falls vorhanden.
  const tessdata = path.join(rootDir, "tessdata");
  if (existsSync(tessdata)) {
    mkdirSync(path.join(target, "tessdata"), { recursive: true });
    for (const lang of ["deu.traineddata", "eng.traineddata", "osd.traineddata"]) {
      const src = path.join(tessdata, lang);
      if (existsSync(src)) cpSync(src, path.join(target, "tessdata", lang));
    }
  }
  console.log("✓ Tesseract gebündelt →", path.relative(root, target), `(Quelle: ${rootDir})`);
}

stageSidecar();
stageGhostscript();
stageTesseract();
console.log("Bundle bereit:", path.relative(root, bundleDir));
