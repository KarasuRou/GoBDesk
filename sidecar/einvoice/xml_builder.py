"""Erzeugt EN-16931-konformes CII-XML (ZUGFeRD / Factur-X) aus einer Invoice.

Nutzt facturx.generate_cii_xml: der data_dict ist nach EN-16931-Business-Terms
(BT-/BG-Schlüssel) aufgebaut. XSD- und Schematron-Prüfung sind eingebaut
(kein Java nötig).
"""

from __future__ import annotations

from decimal import Decimal

import facturx

from .model import Invoice, cents

FACTURX_LEVEL = "en16931"


def _amt(amount_cents: int) -> str:
    return str(cents(amount_cents))


def _rate(rate_bp: int) -> str:
    return str((Decimal(rate_bp) / 100).quantize(Decimal("0.01")))


def build_data_dict(inv: Invoice) -> dict:
    seller, buyer = inv.seller, inv.buyer

    dd: dict = {
        # Dokumentkopf
        "BT-1": inv.number,          # Rechnungsnummer
        "BT-2": inv.issue_date,      # Rechnungsdatum
        "BT-3": "380",               # Typ: Handelsrechnung
        "BT-5": inv.currency,        # Währung
        "BT-9": inv.due_date,        # Fälligkeitsdatum (erfüllt BR-CO-25)
        # Verkäufer (BG-4)
        "BT-27": seller.name,
        "BT-35": seller.street,
        "BT-37": seller.city,
        "BT-38": seller.zip,
        "BT-40": seller.country,
        "BT-43": seller.email,
        # Käufer (BG-7)
        "BT-44": buyer.name,
        "BT-50": buyer.street,
        "BT-52": buyer.city,
        "BT-53": buyer.zip,
        "BT-55": buyer.country,
        "BT-58": buyer.email,
        # Summen (BG-22)
        "BT-106": _amt(inv.net_total_cents),   # Summe Nettobeträge der Positionen
        "BT-109": _amt(inv.net_total_cents),   # Steuerbasis gesamt
        "BT-111": _amt(inv.tax_total_cents),   # USt gesamt (Rechnungswährung)
        "BT-111-1": inv.currency,
        "BT-112": _amt(inv.gross_total_cents),  # Bruttobetrag
        "BT-115": _amt(inv.gross_total_cents),  # Fälliger Zahlbetrag
        "BG-25": [],  # Positionen
        "BG-23": [],  # Steueraufschlüsselung
    }

    if inv.service_date:
        dd["BT-72"] = inv.service_date  # tatsächliches Leistungs-/Lieferdatum

    if inv.order_number:
        dd["BT-14"] = inv.order_number  # Auftragsreferenz des Verkäufers (Sales order reference)

    if inv.cancels_number:
        # Referenz auf die stornierte Originalrechnung (BG-3 / BT-25) – macht den
        # Stornobeleg auch in der E-Rechnung maschinenlesbar rückbeziehbar.
        dd["BG-3"] = [{"BT-25": inv.cancels_number}]

    if seller.vat_id:
        dd["BT-31"] = seller.vat_id
    if seller.tax_number:
        dd["BT-32"] = seller.tax_number
    if buyer.vat_id:
        dd["BT-48"] = buyer.vat_id

    for i, line in enumerate(inv.lines, start=1):
        category, rate_bp = inv.line_category(line)
        dd["BG-25"].append(
            {
                "BT-126": str(i),                     # Positionsnummer
                "BT-153": line.description,           # Artikelname
                "BT-146": _amt(line.unit_price_net_cents),  # Nettoeinzelpreis
                "BT-129": f"{line.quantity}",         # Menge
                "BT-130": line.unit,                  # Einheit (UN/ECE Rec 20)
                "BT-131": _amt(line.net_cents),       # Nettobetrag der Position
                "BT-151": category,                   # USt-Kategorie
                "BT-152": _rate(rate_bp),             # USt-Satz
            }
        )

    for row in inv.breakdown:
        entry = {
            "BT-116": _amt(row.net_cents),   # Steuerbasis je Satz
            "BT-117": _amt(row.tax_cents),   # Steuerbetrag je Satz
            "BT-118": row.category,          # Kategorie
            "BT-119": _rate(row.rate_bp),    # Satz
        }
        if row.exemption_reason:
            entry["BT-120"] = row.exemption_reason
        dd["BG-23"].append(entry)

    return dd


def build_xml(inv: Invoice, *, validate: bool = True) -> bytes:
    dd = build_data_dict(inv)
    return facturx.generate_cii_xml(
        dd,
        level=FACTURX_LEVEL,
        check_xsd=validate,
        check_schematron="base" if validate else False,
    )
