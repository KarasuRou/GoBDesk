"""PDF/A-3-Konvertierung via Ghostscript + Einbetten des ZUGFeRD-XML via factur-x.

Ablauf: Basis-PDF --(Ghostscript, PDF/A-3 + sRGB-OutputIntent)--> PDF/A-3
        --(factur-x, Associated File + XMP)--> hybrides ZUGFeRD-PDF.
"""

from __future__ import annotations

import glob
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import facturx

_PDFA_DEF_TEMPLATE = """%!
[ /_objdef {{icc_PDFA}} /type /stream /OBJ pdfmark
[ {{icc_PDFA}} << /N 3 >> /PUT pdfmark
[ {{icc_PDFA}} ({icc_path}) (r) file /PUT pdfmark
[ /_objdef {{OutputIntent_PDFA}} /type /dict /OBJ pdfmark
[ {{OutputIntent_PDFA}} <<
  /Type /OutputIntent
  /S /GTS_PDFA1
  /DestOutputProfile {{icc_PDFA}}
  /OutputConditionIdentifier (sRGB)
  /Info (sRGB IEC61966-2.1)
>> /PUT pdfmark
[ {{Catalog}} << /OutputIntents [ {{OutputIntent_PDFA}} ] >> /PUT pdfmark
"""


def _find_ghostscript() -> str:
    # Gebündeltes Ghostscript hat Vorrang (gesetzt vom Electron-Hauptprozess im
    # Paket-Modus); im Dev fällt es auf PATH bzw. die Standardinstallation zurück.
    override = os.environ.get("GOBDESK_GS")
    if override and Path(override).exists():
        return override
    for name in ("gswin64c", "gswin32c", "gs"):
        found = shutil.which(name)
        if found:
            return found
    for pattern in (
        r"C:\Program Files\gs\*\bin\gswin64c.exe",
        r"C:\Program Files (x86)\gs\*\bin\gswin32c.exe",
    ):
        matches = sorted(glob.glob(pattern))
        if matches:
            return matches[-1]
    raise RuntimeError("Ghostscript (gswin64c) wurde nicht gefunden.")


def _find_srgb_icc(gs_exe: str) -> Path:
    override = os.environ.get("GOBDESK_GS_ICC")
    if override and Path(override).exists():
        return Path(override)
    root = Path(gs_exe).resolve().parent.parent
    icc = root / "iccprofiles" / "srgb.icc"
    if icc.exists():
        return icc
    matches = list(root.glob("**/srgb.icc"))
    if matches:
        return matches[0]
    raise RuntimeError("ICC-Profil srgb.icc nicht gefunden.")


def to_pdfa3(input_pdf: Path, output_pdf: Path) -> Path:
    gs = _find_ghostscript()
    icc_ps_path = str(_find_srgb_icc(gs)).replace("\\", "/")

    with tempfile.NamedTemporaryFile("w", suffix=".ps", delete=False, encoding="latin-1") as fh:
        fh.write(_PDFA_DEF_TEMPLATE.format(icc_path=icc_ps_path))
        def_ps = fh.name

    try:
        cmd = [
            gs,
            # SAFER-Modus: gezielt nur das ICC-Profil zum Lesen freigeben.
            f"--permit-file-read={icc_ps_path}",
            "-dPDFA=3", "-dBATCH", "-dNOPAUSE", "-dNOOUTERSAVE", "-dQUIET",
            "-sProcessColorModel=DeviceRGB", "-sColorConversionStrategy=RGB",
            "-sDEVICE=pdfwrite", "-dPDFACompatibilityPolicy=1",
            f"-sOutputFile={output_pdf}", def_ps, str(input_pdf),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not output_pdf.exists():
            raise RuntimeError(
                f"Ghostscript-Konvertierung fehlgeschlagen (Code {proc.returncode}).\n"
                f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr}"
            )
    finally:
        Path(def_ps).unlink(missing_ok=True)
    return output_pdf


def embed_xml(pdfa_pdf: Path, xml: bytes, output_pdf: Path) -> Path:
    facturx.generate_from_file(
        str(pdfa_pdf),
        xml,
        flavor="factur-x",
        level="en16931",
        check_xsd=True,
        check_schematron=False,  # bereits im xml_builder geprüft
        output_pdf_file=str(output_pdf),
    )
    return output_pdf
