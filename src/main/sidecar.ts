/** Aufruf des Python-Sidecars: Request-JSON über stdin, Ergebnis-JSON über stdout. */

import { spawn } from "node:child_process";

import type { ValidationResult } from "../shared/api.js";

export interface SidecarResult {
  ok: boolean;
  pdf_path?: string;
  xml_path?: string;
  error?: string;
  trace?: string;
}

/** Standard-Timeout je Sidecar-Aufruf (OCR großer Scans kann etwas dauern). */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Startbefehl des Sidecars: im Paket-Modus das gebündelte PyInstaller-Binary
 * (`GOBDESK_SIDECAR_BIN`), sonst der Python-Interpreter (`py -3.11 -m einvoice`).
 */
function resolveSidecar(sidecarDir: string): {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const bundled = process.env["GOBDESK_SIDECAR_BIN"];
  if (bundled) {
    return { cmd: bundled, args: [], env: { ...process.env } };
  }
  return {
    cmd: "py",
    args: ["-3.11", "-m", "einvoice"],
    env: { ...process.env, PYTHONPATH: sidecarDir },
  };
}

function callSidecar<T>(
  request: unknown,
  sidecarDir: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const { cmd, args, env } = resolveSidecar(sidecarDir);
    const child = spawn(cmd, args, { cwd: sidecarDir, env });

    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill();
        reject(new Error(`Sidecar-Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)}s.`));
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString("utf8")));

    child.on("error", (e) =>
      finish(() => reject(new Error(`Sidecar konnte nicht gestartet werden: ${e.message}`))),
    );
    child.on("close", (code) =>
      finish(() => {
        try {
          resolve(JSON.parse(out) as T);
        } catch {
          reject(
            new Error(
              `Sidecar lieferte kein gültiges JSON (Code ${code}). ${(err || out).slice(0, 400)}`,
            ),
          );
        }
      }),
    );

    child.stdin.write(Buffer.from(JSON.stringify(request), "utf8"));
    child.stdin.end();
  });
}

export function renderInvoicePdf(request: unknown, sidecarDir: string): Promise<SidecarResult> {
  return callSidecar<SidecarResult>(request, sidecarDir);
}

/** Schnelle Vorschau: nur das Basis-PDF (Command `preview`). */
export function previewInvoicePdf(request: unknown, sidecarDir: string): Promise<SidecarResult> {
  return callSidecar<SidecarResult>(request, sidecarDir, 30_000);
}

/** Prüft eine bestehende ZUGFeRD-PDF/-XML gegen EN 16931 (XSD + Schematron). */
export function validateInvoice(filePath: string, sidecarDir: string): Promise<ValidationResult> {
  return callSidecar<ValidationResult>({ command: "validate", path: filePath }, sidecarDir, 60_000);
}

/** Extrahiert Text (PDF-Textlayer bzw. OCR) für die DMS-Volltextsuche. */
export function extractText(filePath: string, sidecarDir: string): Promise<string> {
  return callSidecar<{ ok: boolean; text?: string }>(
    { command: "extract", path: filePath },
    sidecarDir,
  ).then((r) => r.text ?? "");
}

/** Erkennt empfangene E-Rechnungen (ZUGFeRD/XRechnung) und liest die Kerndaten. */
export function readInboundEInvoice(
  filePath: string,
  sidecarDir: string,
): Promise<{ ok: boolean; is_einvoice?: boolean; data?: unknown; error?: string }> {
  return callSidecar({ command: "einvoice", path: filePath }, sidecarDir, 30_000);
}
