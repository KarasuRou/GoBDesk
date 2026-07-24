"""Erzeugt das Basis-PDF der Rechnung mit reportlab (reines Python).

Bewusst schlicht gehalten; enthält die §14-UStG-Pflichtangaben und im
Kleinunternehmer-Fall den §19-Hinweis. Die PDF/A-3-Konformität wird
anschließend per Ghostscript hergestellt (siehe pdfa.py).
"""

from __future__ import annotations

import sys
from decimal import Decimal
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from .model import Invoice, KLEINUNTERNEHMER_HINWEIS, cents

# Schrift echt einbetten (DejaVu Sans) statt der Standard-14-Schriften – so muss
# der Viewer (z. B. Acrobat) keine System-Schrift substituieren/"capturen".
# Im PyInstaller-Bundle liegen die Schriften unter sys._MEIPASS/fonts.
_BASE_DIR = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
_FONT_DIR = _BASE_DIR / "fonts"
FONT = "DejaVuSans"
FONT_BOLD = "DejaVuSans-Bold"
pdfmetrics.registerFont(TTFont(FONT, str(_FONT_DIR / "DejaVuSans.ttf")))
pdfmetrics.registerFont(TTFont(FONT_BOLD, str(_FONT_DIR / "DejaVuSans-Bold.ttf")))
registerFontFamily(FONT, normal=FONT, bold=FONT_BOLD)


def _eur(amount_cents: int) -> str:
    s = f"{cents(amount_cents):,.2f}"  # 1,200.00 (US-Format)
    s = s.replace(",", " ").replace(".", ",").replace(" ", ".")  # -> 1.200,00
    return f"{s} €"


def _qty(milli: int) -> str:
    return f"{(Decimal(milli) / 1000).normalize()}".replace(".", ",")


def build_pdf(inv: Invoice, path: str) -> str:
    styles = getSampleStyleSheet()
    normal = styles["Normal"]
    normal.fontName = FONT
    small = ParagraphStyle("small", parent=normal, fontSize=8, leading=10, textColor=colors.grey)
    h1 = ParagraphStyle("h1", parent=styles["Heading1"], fontSize=16, fontName=FONT_BOLD)

    kind = "Stornorechnung" if inv.cancels_number else "Rechnung"
    doc = SimpleDocTemplate(
        path, pagesize=A4,
        leftMargin=25 * mm, rightMargin=20 * mm, topMargin=20 * mm, bottomMargin=18 * mm,
        title=f"{kind} {inv.number}", author=inv.seller.name,
        subject=kind, creator="GoBDesk",
    )
    s, b = inv.seller, inv.buyer
    story: list = []

    story.append(Paragraph(f"{s.name} &#183; {s.street} &#183; {s.zip} {s.city}", small))
    story.append(Spacer(1, 10 * mm))

    story.append(Paragraph(b.name, normal))
    if b.street:
        story.append(Paragraph(b.street, normal))
    story.append(Paragraph(f"{b.zip or ''} {b.city or ''}".strip(), normal))
    story.append(Spacer(1, 10 * mm))

    meta = [
        ["Rechnungsnummer:", inv.number],
        ["Rechnungsdatum:", inv.issue_date.strftime("%d.%m.%Y")],
        ["Leistungsdatum:", inv.service_date.strftime("%d.%m.%Y") if inv.service_date else "-"],
    ]
    if inv.order_number:
        meta.append(["Auftragsnummer:", inv.order_number])
    if inv.cancels_number:
        meta.append(["Storno zu Rechnung:", inv.cancels_number])
    meta_tbl = Table(meta, colWidths=[38 * mm, 45 * mm], hAlign="RIGHT")
    meta_tbl.setStyle(
        TableStyle([("FONTNAME", (0, 0), (-1, -1), FONT), ("FONTSIZE", (0, 0), (-1, -1), 9)])
    )
    story.append(meta_tbl)
    story.append(Spacer(1, 6 * mm))

    story.append(Paragraph(f"{kind} {inv.number}", h1))
    story.append(Spacer(1, 4 * mm))

    rows = [["Pos.", "Beschreibung", "Menge", "Einheit", "Einzelpreis", "USt", "Betrag"]]
    for i, line in enumerate(inv.lines, start=1):
        _, rate_bp = inv.line_category(line)
        rows.append([
            str(i), line.description, _qty(line.quantity_milli), line.unit,
            _eur(line.unit_price_net_cents), f"{rate_bp // 100} %", _eur(line.net_cents),
        ])
        # DESIGN: Zu-/Abschläge erscheinen als kleine graue Fußnote unter der
        # Positionszeile, nicht als eigene Spalte. So bleibt die Betragsspalte
        # eindeutig (sie zeigt immer das Positions-Netto NACH Zu-/Abschlag) und
        # der Leser kann trotzdem nachvollziehen, wie der Wert zustande kommt.
        notes = []
        if line.discount_cents:
            r = line.discount.reason if line.discount and line.discount.reason else "Rabatt"
            notes.append(f"abzgl. {r}: -{_eur(line.discount_cents)}")
        if line.surcharge_cents:
            r = line.surcharge.reason if line.surcharge and line.surcharge.reason else "Aufpreis"
            notes.append(f"zzgl. {r}: +{_eur(line.surcharge_cents)}")
        if notes:
            rows.append(["", Paragraph(" &#183; ".join(notes), small), "", "", "", "", ""])
    items = Table(rows, colWidths=[11 * mm, 60 * mm, 16 * mm, 16 * mm, 25 * mm, 12 * mm, 25 * mm])
    items.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), FONT),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#ececec")),
        ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black),
        ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor("#cccccc")),
        ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    story.append(items)
    story.append(Spacer(1, 4 * mm))

    # DESIGN: Der Summenblock zeigt den Rechenweg nur, wenn es etwas zu zeigen
    # gibt: ohne Rechnungs-Rabatt bleibt es bei Netto/USt/Gesamt, mit Rabatt
    # werden "Zwischensumme netto" und der Abzug davorgesetzt. Gesamtbetrag ist
    # die einzige fette Zeile mit Trennlinie darüber.
    totals = []
    if inv.invoice_discount_cents > 0:
        r = inv.discount.reason if inv.discount and inv.discount.reason else "Rabatt"
        totals.append(["Zwischensumme netto", _eur(inv.line_net_sum_cents)])
        totals.append([f"abzgl. {r}", "-" + _eur(inv.invoice_discount_cents)])
    totals.append(["Nettobetrag", _eur(inv.net_total_cents)])
    for row in inv.breakdown:
        if not inv.is_kleinunternehmer and row.rate_bp > 0:
            totals.append([f"zzgl. USt {row.rate_bp // 100} %", _eur(row.tax_cents)])
    totals.append(["Gesamtbetrag", _eur(inv.gross_total_cents)])
    totals_tbl = Table(totals, colWidths=[50 * mm, 30 * mm], hAlign="RIGHT")
    totals_tbl.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), FONT),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("LINEABOVE", (0, -1), (-1, -1), 0.6, colors.black),
        ("FONTNAME", (0, -1), (-1, -1), FONT_BOLD),
        ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]))
    story.append(totals_tbl)
    story.append(Spacer(1, 6 * mm))

    # DESIGN: Der Zahlungsplan steht als eigene, linksbündige Tabelle unter dem
    # Summenblock – klar getrennt, weil er eine Zahlungsvereinbarung ist und
    # keine Betragsposition. Schmale Spalten, gleiche Kopfzeilen-Optik wie die
    # Positionstabelle, damit der Beleg als ein Dokument wirkt.
    if inv.installments:
        plan_rows = [["Rate", "Fällig am", "Betrag"]]
        for r in inv.installments:
            plan_rows.append([f"{r.seq}.", r.due_date.strftime("%d.%m.%Y"), _eur(r.amount_cents)])
        plan_tbl = Table(plan_rows, colWidths=[18 * mm, 35 * mm, 30 * mm], hAlign="LEFT")
        plan_tbl.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, -1), FONT),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("FONTNAME", (0, 0), (-1, 0), FONT_BOLD),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#ececec")),
            ("ALIGN", (2, 0), (2, -1), "RIGHT"),
            ("LINEBELOW", (0, 0), (-1, 0), 0.4, colors.black),
            ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
        ]))
        plan_head = ParagraphStyle("plan", parent=normal, fontName=FONT_BOLD, fontSize=10, spaceAfter=3)
        story.append(Paragraph("Zahlungsplan (Ratenzahlung)", plan_head))
        story.append(plan_tbl)
        story.append(Spacer(1, 5 * mm))

    if inv.is_kleinunternehmer:
        story.append(Paragraph(KLEINUNTERNEHMER_HINWEIS, normal))
        story.append(Spacer(1, 4 * mm))
    if inv.payment_terms:
        story.append(Paragraph(inv.payment_terms, normal))
    story.append(Spacer(1, 10 * mm))

    footer = []
    if s.tax_number:
        footer.append(f"Steuernummer: {s.tax_number}")
    if s.vat_id:
        footer.append(f"USt-IdNr: {s.vat_id}")
    if s.iban:
        footer.append(f"IBAN: {s.iban}")
    if s.bic:
        footer.append(f"BIC: {s.bic}")
    if s.email:
        footer.append(s.email)
    story.append(Paragraph(" &#183; ".join(footer), small))

    def draw_watermark(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONT_BOLD, 60)
        canvas.setFillColor(colors.Color(0, 0, 0, alpha=0.07))
        canvas.translate(100 * mm, 150 * mm)
        canvas.rotate(45)
        canvas.drawCentredString(0, 0, "ENTWURF")
        canvas.restoreState()

    if inv.number == "VORSCHAU":
        doc.build(story, onFirstPage=draw_watermark, onLaterPages=draw_watermark)
    else:
        doc.build(story)
    return path
