"""stdin/stdout-Schnittstelle des Sidecars.

Liest ein JSON-Request-Objekt von stdin und schreibt ein JSON-Ergebnis auf
stdout. Commands: 'render' (PDF+XML erzeugen).
"""

from __future__ import annotations

import json
import sys
import traceback

from . import render


def handle(request: dict) -> dict:
    command = request.get("command")
    if command == "render":
        return render.render_invoice(request["invoice"], request.get("output_dir", "out"))
    if command == "preview":
        return render.preview_invoice(request["invoice"], request.get("output_dir", "out"))
    if command == "extract":
        from . import extract

        return extract.extract_text(request["path"])
    if command == "validate":
        from . import validate

        return validate.validate_file(request["path"])
    if command == "einvoice":
        from . import inbound

        return inbound.read_einvoice(request["path"])
    return {"ok": False, "error": f"Unbekannter command: {command!r}"}


def main() -> None:
    # Immer UTF-8, unabhängig vom Windows-Locale (wichtig für die Electron-Anbindung).
    raw = sys.stdin.buffer.read().decode("utf-8")
    try:
        result = handle(json.loads(raw))
    except Exception as exc:  # noqa: BLE001 - Fehler strukturiert zurückgeben
        result = {"ok": False, "error": str(exc), "trace": traceback.format_exc()}
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    main()
