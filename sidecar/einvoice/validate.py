"""Validierung bestehender ZUGFeRD/Factur-X-Dateien (Command `validate`).

Prüft das eingebettete (bzw. übergebene) EN-16931-XML gegen XSD und Schematron –
ohne Neuerzeugung. PDF/A-Konformität wird hier nicht geprüft (das übernimmt im
Dev veraPDF); Fokus ist die inhaltliche EN-16931-Gültigkeit.
"""

from __future__ import annotations

from pathlib import Path

import facturx


def _validate_xml(xml: bytes) -> dict:
    errors: list[str] = []
    try:
        facturx.xml_check_xsd(xml, flavor="autodetect", level="autodetect")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"XSD: {exc}")
    try:
        facturx.xml_check_schematron(xml, flavor="autodetect", level="autodetect", check_option="base")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"Schematron: {exc}")
    return {"ok": True, "valid": len(errors) == 0, "xml_found": True, "errors": errors}


def validate_file(path: str) -> dict:
    p = Path(path)
    if not p.exists():
        return {"ok": False, "error": f"Datei nicht gefunden: {path}"}

    ext = p.suffix.lower()
    try:
        if ext == ".pdf":
            with p.open("rb") as fh:  # factur-x erwartet ein Datei-Objekt, keinen Pfad
                extracted = facturx.get_facturx_xml_from_pdf(
                    fh, check_xsd=False, check_schematron=False
                )
            xml = extracted[1] if isinstance(extracted, tuple) else extracted
            if not xml:
                return {
                    "ok": True,
                    "valid": False,
                    "xml_found": False,
                    "errors": ["Kein eingebettetes ZUGFeRD/Factur-X-XML gefunden."],
                }
            return _validate_xml(xml)
        if ext == ".xml":
            return _validate_xml(p.read_bytes())
        return {"ok": False, "error": f"Nicht unterstützter Dateityp: {ext}"}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
