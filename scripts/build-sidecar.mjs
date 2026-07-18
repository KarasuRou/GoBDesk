/**
 * Baut das eigenständige Sidecar-Binary mit PyInstaller (Phase 8).
 *
 * Wählt den Python-Interpreter robust: `PYTHON`-Env (z. B. auf CI: "python"),
 * sonst der Windows-py-Launcher `py -3.11`, sonst `python`/`python3`. So läuft
 * derselbe Befehl lokal und in GitHub Actions.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON.trim().split(/\s+/);
  const candidates = [["py", "-3.11"], ["python"], ["python3"]];
  for (const cand of candidates) {
    const probe = spawnSync(cand[0], [...cand.slice(1), "--version"], { encoding: "utf8" });
    if (probe.status === 0) return cand;
  }
  throw new Error("Kein Python 3.11 gefunden (weder PYTHON-Env noch py/python).");
}

const py = resolvePython();
const args = [
  ...py.slice(1),
  "-m",
  "PyInstaller",
  "sidecar/einvoice.spec",
  "--noconfirm",
  "--clean",
  "--distpath",
  "sidecar/dist",
  "--workpath",
  "sidecar/build",
];

console.log("Sidecar-Build:", [py[0], ...args].join(" "));
const res = spawnSync(py[0], args, { stdio: "inherit", cwd: root });
process.exit(res.status ?? 1);
