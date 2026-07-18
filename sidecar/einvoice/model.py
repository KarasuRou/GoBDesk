"""Eingangsdatenmodell + Betragsberechnung für die E-Rechnung.

Konventionen (identisch zum Rust-/TS-Core):
  * Geldbeträge in Cent (int), Steuersätze in Basispunkten (1900 = 19 %),
    Mengen in Tausendstel (1000 = 1,000 Einheiten).
Die USt wird gemäß EN 16931 je Steuersatz auf die Netto-Summe berechnet.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

KLEINUNTERNEHMER_HINWEIS = "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet."
KLEINUNTERNEHMER_BEFREIUNG = "Steuerbefreiung gemäß § 19 UStG (Kleinunternehmer)"


def round_div(numerator: int, denominator: int) -> int:
    """Kaufmännische Rundung (round half away from zero), ganzzahlig in Cent.

    Achtung: Pythons ``//`` ist Floor-Division (rundet Richtung -unendlich),
    nicht Truncation wie in TypeScript/Rust. Negative Werte werden deshalb
    über den negierten Positiv-Fall gerechnet, sonst entsteht bei exakt
    teilbaren negativen Beträgen (z. B. Stornopositionen) 1 Cent Abweichung.
    """
    half = denominator // 2
    if numerator >= 0:
        return (numerator + half) // denominator
    return -((-numerator + half) // denominator)


def cents(amount_cents: int) -> Decimal:
    return (Decimal(amount_cents) / 100).quantize(Decimal("0.01"), ROUND_HALF_UP)


@dataclass
class Party:
    name: str
    street: str | None
    zip: str | None
    city: str | None
    country: str
    vat_id: str | None = None
    tax_number: str | None = None
    email: str | None = None
    iban: str | None = None
    bic: str | None = None

    @classmethod
    def from_json(cls, d: dict) -> "Party":
        return cls(
            name=d["name"],
            street=d.get("street"),
            zip=d.get("zip"),
            city=d.get("city"),
            country=d.get("country", "DE"),
            vat_id=d.get("vat_id"),
            tax_number=d.get("tax_number"),
            email=d.get("email"),
            iban=d.get("iban"),
            bic=d.get("bic"),
        )


@dataclass
class Line:
    description: str
    quantity_milli: int
    unit: str
    unit_price_net_cents: int
    tax_rate_bp: int
    net_cents: int = 0  # berechnet

    @property
    def quantity(self) -> Decimal:
        return (Decimal(self.quantity_milli) / 1000).quantize(Decimal("0.0001"))


@dataclass
class TaxRow:
    category: str  # "S" (Regel), "E" (befreit, z. B. §19), "Z" (Nullsatz)
    rate_bp: int
    net_cents: int
    tax_cents: int
    exemption_reason: str | None = None


@dataclass
class Invoice:
    number: str
    issue_date: date
    service_date: date | None
    due_date: date
    currency: str
    is_kleinunternehmer: bool
    seller: Party
    buyer: Party
    lines: list[Line]
    payment_terms: str | None
    order_number: str | None = None  # Auftragsnummer des Verkäufers (EN 16931 BT-14)
    cancels_number: str | None = None  # stornierte Originalrechnung (EN 16931 BT-25)
    breakdown: list[TaxRow] = field(default_factory=list)
    net_total_cents: int = 0
    tax_total_cents: int = 0
    gross_total_cents: int = 0

    @classmethod
    def from_json(cls, d: dict) -> "Invoice":
        issue = date.fromisoformat(d["issue_date"])
        due = date.fromisoformat(d["due_date"]) if d.get("due_date") else issue + timedelta(days=14)
        inv = cls(
            number=d["number"],
            issue_date=issue,
            service_date=date.fromisoformat(d["service_date"]) if d.get("service_date") else None,
            due_date=due,
            currency=d.get("currency", "EUR"),
            is_kleinunternehmer=bool(d["is_kleinunternehmer"]),
            seller=Party.from_json(d["seller"]),
            buyer=Party.from_json(d["buyer"]),
            lines=[
                Line(
                    description=l["description"],
                    quantity_milli=l["quantity_milli"],
                    unit=l.get("unit", "C62"),
                    unit_price_net_cents=l["unit_price_net_cents"],
                    tax_rate_bp=l["tax_rate_bp"],
                )
                for l in d["lines"]
            ],
            payment_terms=d.get("payment_terms"),
            order_number=d.get("order_number"),
            cancels_number=d.get("cancels_number"),
        )
        inv._compute()
        return inv

    def line_category(self, line: Line) -> tuple[str, int]:
        """Liefert (Kategorie-Code, effektiver Satz in bp) für eine Position."""
        if self.is_kleinunternehmer:
            return "E", 0
        if line.tax_rate_bp == 0:
            return "Z", 0
        return "S", line.tax_rate_bp

    def _compute(self) -> None:
        net_by_rate: dict[int, int] = {}
        for line in self.lines:
            line.net_cents = round_div(line.quantity_milli * line.unit_price_net_cents, 1000)
            _, rate = self.line_category(line)
            net_by_rate[rate] = net_by_rate.get(rate, 0) + line.net_cents

        breakdown: list[TaxRow] = []
        net_total = tax_total = 0
        for rate_bp in sorted(net_by_rate):
            net = net_by_rate[rate_bp]
            tax = round_div(net * rate_bp, 10_000)
            if self.is_kleinunternehmer:
                category, reason = "E", KLEINUNTERNEHMER_BEFREIUNG
            elif rate_bp == 0:
                category, reason = "Z", None
            else:
                category, reason = "S", None
            breakdown.append(TaxRow(category, rate_bp, net, tax, reason))
            net_total += net
            tax_total += tax

        self.breakdown = breakdown
        self.net_total_cents = net_total
        self.tax_total_cents = tax_total
        self.gross_total_cents = net_total + tax_total
