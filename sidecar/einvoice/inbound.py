"""Liest empfangene E-Rechnungen (Eingangsrechnungen) für das DMS.

Erkennt ZUGFeRD/Factur-X (XML in PDF/A-3 eingebettet) sowie XRechnung als
reine XML-Datei (CII- und UBL-Syntax) und extrahiert die Kerndaten für die
komfortable Übernahme als Ausgabe. Die Datei selbst bleibt unverändert das
aufbewahrungspflichtige Original (GoBD Rz. 131).
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from pathlib import Path

from lxml import etree


def _first_text(tree, local_name: str, parent_local: str | None = None) -> str | None:
    """Erster Textinhalt eines Elements, namespace-agnostisch (CII/UBL-Varianten)."""
    if parent_local:
        xpath = f"//*[local-name()='{parent_local}']//*[local-name()='{local_name}']"
    else:
        xpath = f"//*[local-name()='{local_name}']"
    for node in tree.xpath(xpath):
        text = (node.text or "").strip()
        if text:
            return text
    return None


def _to_cents(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int((Decimal(value) * 100).quantize(Decimal("1")))
    except (InvalidOperation, ValueError):
        return None


def _to_bp(value: str | None) -> int | None:
    if not value:
        return None
    try:
        return int((Decimal(value) * 100).quantize(Decimal("1")))
    except (InvalidOperation, ValueError):
        return None


def _iso_date(value: str | None) -> str | None:
    if not value:
        return None
    v = value.strip()
    if len(v) == 8 and v.isdigit():  # CII Format 102: JJJJMMTT
        return f"{v[0:4]}-{v[4:6]}-{v[6:8]}"
    return v[:10] if len(v) >= 10 else v


def _parse_xml(xml_bytes: bytes) -> dict | None:
    try:
        tree = etree.fromstring(xml_bytes)
    except etree.XMLSyntaxError:
        return None

    root = etree.QName(tree).localname
    if root == "CrossIndustryInvoice":  # CII (ZUGFeRD/Factur-X, XRechnung-CII)
        return {
            "syntax": "CII",
            "number": _first_text(tree, "ID", "ExchangedDocument"),
            "issue_date": _iso_date(_first_text(tree, "DateTimeString", "IssueDateTime")),
            "seller": _first_text(tree, "Name", "SellerTradeParty"),
            "gross_cents": _to_cents(
                _first_text(tree, "GrandTotalAmount")
            ),
            "tax_cents": _to_cents(_first_text(tree, "TaxTotalAmount")),
            "tax_rate_bp": _to_bp(_first_text(tree, "RateApplicablePercent")),
            "currency": _first_text(tree, "InvoiceCurrencyCode"),
        }
    if root in ("Invoice", "CreditNote"):  # UBL (XRechnung-UBL)
        return {
            "syntax": "UBL",
            "number": _first_text(tree, "ID"),
            "issue_date": _iso_date(_first_text(tree, "IssueDate")),
            "seller": _first_text(tree, "RegistrationName", "AccountingSupplierParty")
            or _first_text(tree, "Name", "AccountingSupplierParty"),
            "gross_cents": _to_cents(_first_text(tree, "TaxInclusiveAmount")),
            "tax_cents": _to_cents(_first_text(tree, "TaxAmount")),
            "tax_rate_bp": _to_bp(_first_text(tree, "Percent")),
            "currency": _first_text(tree, "DocumentCurrencyCode"),
        }
    return None


def read_einvoice(path_str: str) -> dict:
    """Prüft, ob eine Datei eine E-Rechnung ist, und extrahiert die Kerndaten."""
    p = Path(path_str)
    if not p.exists():
        return {"ok": False, "error": f"Datei nicht gefunden: {path_str}"}

    xml_bytes: bytes | None = None
    suffix = p.suffix.lower()
    if suffix == ".xml":
        xml_bytes = p.read_bytes()
    elif suffix == ".pdf":
        try:
            import facturx

            with p.open("rb") as fh:
                _, xml_bytes = facturx.get_facturx_xml_from_pdf(fh, check_xsd=False)
        except Exception:  # noqa: BLE001 - kein eingebettetes XML -> keine E-Rechnung
            xml_bytes = None

    if not xml_bytes:
        return {"ok": True, "is_einvoice": False}

    data = _parse_xml(xml_bytes)
    if data is None:
        return {"ok": True, "is_einvoice": False}
    return {"ok": True, "is_einvoice": True, "data": data}
