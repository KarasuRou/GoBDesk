"""Orchestriert die Render-Pipeline: JSON -> XML + PDF/A-3 -> hybrides ZUGFeRD-PDF."""

from __future__ import annotations

from pathlib import Path

from . import pdf_builder, pdfa, xml_builder
from .model import Invoice


def render_invoice(invoice_data: dict, output_dir: str = "out") -> dict:
    inv = Invoice.from_json(invoice_data)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    base_pdf = out / f"{inv.number}_base.pdf"
    pdfa_pdf = out / f"{inv.number}_pdfa.pdf"
    final_pdf = out / f"{inv.number}.pdf"
    xml_path = out / f"{inv.number}.xml"

    xml = xml_builder.build_xml(inv, validate=True)
    xml_path.write_bytes(xml)

    pdf_builder.build_pdf(inv, str(base_pdf))
    pdfa.to_pdfa3(base_pdf, pdfa_pdf)
    pdfa.embed_xml(pdfa_pdf, xml, final_pdf)

    # Zwischendateien entfernen – nur finales PDF + XML behalten.
    base_pdf.unlink(missing_ok=True)
    pdfa_pdf.unlink(missing_ok=True)

    return {
        "ok": True,
        "pdf_path": str(final_pdf),
        "xml_path": str(xml_path),
        "totals": {
            "net_cents": inv.net_total_cents,
            "tax_cents": inv.tax_total_cents,
            "gross_cents": inv.gross_total_cents,
        },
    }


def preview_invoice(invoice_data: dict, output_dir: str = "out") -> dict:
    """Schnelle Vorschau: nur das Basis-PDF (ohne PDF/A-Konvertierung und XML)."""
    inv = Invoice.from_json(invoice_data)
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    preview_pdf = out / f"{inv.number}_preview.pdf"
    pdf_builder.build_pdf(inv, str(preview_pdf))
    return {
        "ok": True,
        "pdf_path": str(preview_pdf),
        "totals": {
            "net_cents": inv.net_total_cents,
            "tax_cents": inv.tax_total_cents,
            "gross_cents": inv.gross_total_cents,
        },
    }
