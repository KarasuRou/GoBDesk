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
        "BT-106": _amt(inv.line_net_sum_cents),  # Summe Nettobeträge der Positionen
        "BT-109": _amt(inv.net_total_cents),   # Steuerbasis gesamt (nach Rechnungs-Rabatt)
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

    if inv.invoice_discount_cents > 0:
        # Rechnungsweiter Rabatt: Summe (BT-107) + je Steuersatz ein Nachlass
        # auf Dokumentebene (BG-20). Grund ist Pflicht (BR-33).
        dd["BT-107"] = _amt(inv.invoice_discount_cents)
        reason = inv.discount.reason if inv.discount and inv.discount.reason else "Rabatt"
        dd["BG-20"] = [
            {
                "BT-92": _amt(a.amount_cents),  # Nachlassbetrag
                "BT-95": a.category,            # USt-Kategorie des Nachlasses
                "BT-96": _rate(a.rate_bp),      # USt-Satz des Nachlasses
                "BT-97": reason,                # Grund (BR-33)
            }
            for a in inv.allowances_by_rate
        ]

    if seller.vat_id:
        dd["BT-31"] = seller.vat_id
    if seller.tax_number:
        dd["BT-32"] = seller.tax_number
    if buyer.vat_id:
        dd["BT-48"] = buyer.vat_id

    for i, line in enumerate(inv.lines, start=1):
        category, rate_bp = inv.line_category(line)
        entry: dict = {
            "BT-126": str(i),                     # Positionsnummer
            "BT-153": line.description,           # Artikelname
            "BT-146": _amt(line.unit_price_net_cents),  # Nettoeinzelpreis
            "BT-129": f"{line.quantity}",         # Menge
            "BT-130": line.unit,                  # Einheit (UN/ECE Rec 20)
            "BT-131": _amt(line.net_cents),       # Nettobetrag der Position (BT-146×Menge − Rabatt + Aufpreis)
            "BT-151": category,                   # USt-Kategorie
            "BT-152": _rate(rate_bp),             # USt-Satz
        }
        if line.discount_cents:
            # Positions-Rabatt (BG-27); Grund ist Pflicht (BR-42).
            entry["BG-27"] = [
                {
                    "BT-136": _amt(line.discount_cents),  # Nachlassbetrag
                    "BT-137": _amt(line.base_cents),      # Grundbetrag
                    "BT-139": line.discount.reason if line.discount and line.discount.reason else "Rabatt",
                }
            ]
        if line.surcharge_cents:
            # Positions-Aufpreis (BG-28); Grund ist Pflicht (BR-44).
            entry["BG-28"] = [
                {
                    "BT-141": _amt(line.surcharge_cents),  # Zuschlagsbetrag
                    "BT-142": _amt(line.base_cents),       # Grundbetrag
                    "BT-144": line.surcharge.reason if line.surcharge and line.surcharge.reason else "Aufpreis",
                }
            ]
        dd["BG-25"].append(entry)

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
