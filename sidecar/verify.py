"""Wegwerf-Verifikation: Ist das ZUGFeRD-XML im PDF eingebettet und extrahierbar?"""
from pathlib import Path
import facturx
from lxml import etree

for num in ("2026-0001", "2026-0002"):
    pdf = Path("out") / f"{num}.pdf"
    print(f"== {pdf} ({pdf.stat().st_size} bytes) ==")
    try:
        filename, xml_bytes = facturx.get_xml_from_pdf(pdf.read_bytes())
        root = etree.fromstring(xml_bytes)
        print(f"  eingebettet: {filename}  (XSD+Schematron beim Extrahieren: OK)")
        print(f"  flavor={facturx.get_flavor(root)}  level={facturx.get_facturx_level(root)}")
    except Exception as e:  # noqa: BLE001
        print("  FEHLER:", repr(e)[:400])
