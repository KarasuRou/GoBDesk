"""Text-/OCR-Extraktion für die DMS-Volltextsuche.

Strategie:
  * PDF mit Textlayer   -> pypdf (schnell, ohne OCR)
  * PDF-Scan / Bild     -> Tesseract, falls verfügbar (Ghostscript rastert PDF-Seiten)
  * Text/XML/CSV        -> direkt einlesen

Ist kein Tesseract vorhanden, bleibt der OCR-Teil leer (best effort) – digitale
PDFs sind trotzdem durchsuchbar.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".tif", ".tiff", ".bmp"}
_TEXT_EXT = {".txt", ".xml", ".csv", ".md"}


def _find_tesseract() -> str | None:
    override = os.environ.get("GOBDESK_TESSERACT")
    if override and Path(override).exists():
        return override
    return shutil.which("tesseract")


def _pdf_text(path: str) -> str:
    from pypdf import PdfReader

    reader = PdfReader(path)
    parts: list[str] = []
    for page in reader.pages:
        try:
            parts.append(page.extract_text() or "")
        except Exception:
            continue
    return "\n".join(parts).strip()


def _tesseract(image_path: str) -> str:
    exe = _find_tesseract()
    if not exe:
        return ""
    for langs in ("deu+eng", None):  # bei fehlendem Sprachpaket ohne -l erneut versuchen
        cmd = [exe, image_path, "stdout"] + (["-l", langs] if langs else [])
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        except Exception:
            continue
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    return ""


def _ocr_pdf(path: str) -> str:
    if not _find_tesseract():
        return ""
    from .pdfa import _find_ghostscript

    try:
        gs = _find_ghostscript()
    except Exception:
        return ""

    parts: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        pattern = str(Path(tmp) / "page-%03d.png")
        cmd = [
            gs, "-dBATCH", "-dNOPAUSE", "-dQUIET",
            "-sDEVICE=png16m", "-r200", f"-sOutputFile={pattern}", path,
        ]
        try:
            subprocess.run(cmd, capture_output=True, text=True)
        except Exception:
            return ""
        for image in sorted(Path(tmp).glob("page-*.png")):
            text = _tesseract(str(image))
            if text:
                parts.append(text)
    return "\n".join(parts).strip()


def extract_text(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {"ok": False, "error": f"Datei nicht gefunden: {path}"}

    ext = p.suffix.lower()
    try:
        if ext == ".pdf":
            text = _pdf_text(path)
            if len(text) < 20:  # kaum Text -> vermutlich Scan -> OCR versuchen
                ocr = _ocr_pdf(path)
                if ocr:
                    text = ocr
            return {"ok": True, "text": text}
        if ext in _IMAGE_EXT:
            return {"ok": True, "text": _tesseract(path)}
        if ext in _TEXT_EXT:
            return {"ok": True, "text": p.read_text(encoding="utf-8", errors="ignore").strip()}
        return {"ok": True, "text": ""}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
