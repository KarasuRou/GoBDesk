"""Wegwerf-Probe: XML-Erzeugung + Validierung für ein Sample. Nicht Teil des Sidecars."""
import json
import sys
from pathlib import Path

from einvoice.model import Invoice
from einvoice import xml_builder

sample = sys.argv[1] if len(sys.argv) > 1 else "samples/invoice_regel.json"
data = json.loads(Path(sample).read_text(encoding="utf-8"))
inv = Invoice.from_json(data["invoice"])

print(f"Netto={inv.net_total_cents} USt={inv.tax_total_cents} Brutto={inv.gross_total_cents}")
print("Breakdown:", [(r.category, r.rate_bp, r.net_cents, r.tax_cents) for r in inv.breakdown])

# 1) Ohne Validierung erzeugen -> XML sichern
xml = xml_builder.build_xml(inv, validate=False)
print("XML-Typ:", type(xml), "Länge:", len(xml))
out = Path("out")
out.mkdir(exist_ok=True)
xml_path = out / (inv.number + ".xml")
xml_path.write_bytes(xml)
print("XML geschrieben:", xml_path)

# 2) Mit Validierung
try:
    xml_builder.build_xml(inv, validate=True)
    print("VALIDIERUNG: OK (XSD + Schematron)")
except Exception as e:  # noqa: BLE001
    print("VALIDIERUNG FEHLGESCHLAGEN:")
    print(repr(e)[:2000])
