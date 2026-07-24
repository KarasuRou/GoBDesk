"""Eingangsdatenmodell + Betragsberechnung für die E-Rechnung.

Konventionen (identisch zum Rust-/TS-Core):
  * Geldbeträge in Cent (int), Steuersätze in Basispunkten (1900 = 19 %),
    Mengen in Tausendstel (1000 = 1,000 Einheiten). Prozentuale Zu-/Abschläge
    ebenfalls in Basispunkten (3000 = 30 %).
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
class Adjustment:
    """Zu-/Abschlag (Rabatt/Aufpreis): prozentual (Wert in bp) oder absolut (Cent)."""

    type: str  # 'percent' | 'amount'
    value: int
    reason: str | None = None

    @classmethod
    def from_json(cls, d: dict | None) -> "Adjustment | None":
        if not d:
            return None
        t, v = d.get("type"), d.get("value")
        if t in ("percent", "amount") and isinstance(v, int):
            return cls(type=t, value=v, reason=d.get("reason"))
        return None

    def amount(self, base_cents: int) -> int:
        if self.type == "percent":
            return round_div(base_cents * self.value, 10_000)
        return self.value


@dataclass
class DocAllowance:
    """Anteil des rechnungsweiten Rabatts je Steuersatz (EN 16931 BG-20)."""

    category: str
    rate_bp: int
    amount_cents: int


@dataclass
class Installment:
    """Eine geplante Rate eines Soll-Zahlungsplans (Ratenplan) – nur Vereinbarung."""

    seq: int
    due_date: date
    amount_cents: int

    @classmethod
    def from_json(cls, d: dict) -> "Installment":
        return cls(
            seq=int(d.get("seq", 0)),
            due_date=date.fromisoformat(d["due_date"]),
            amount_cents=int(d["amount_cents"]),
        )


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
    paypal: str | None = None

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
            paypal=d.get("paypal"),
        )


@dataclass
class Line:
    description: str
    quantity_milli: int
    unit: str
    unit_price_net_cents: int
    tax_rate_bp: int
    discount: Adjustment | None = None   # Positions-Rabatt (BG-27)
    surcharge: Adjustment | None = None  # Positions-Aufpreis (BG-28)
    base_cents: int = 0       # berechnet: Menge × Einzelpreis
    discount_cents: int = 0   # berechnet
    surcharge_cents: int = 0  # berechnet
    net_cents: int = 0        # berechnet: base − Rabatt + Aufpreis (BT-131)

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
    discount: Adjustment | None = None  # rechnungsweiter Rabatt (EN 16931 BG-20)
    breakdown: list[TaxRow] = field(default_factory=list)
    installments: list[Installment] = field(default_factory=list)  # Soll-Zahlungsplan (Ratenplan)
    line_net_sum_cents: int = 0      # Summe Positions-Netto vor Rechnungs-Rabatt (BT-106)
    invoice_discount_cents: int = 0  # Rechnungs-Rabatt gesamt (BT-107)
    allowances_by_rate: list[DocAllowance] = field(default_factory=list)
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
                    discount=Adjustment.from_json(l.get("discount")),
                    surcharge=Adjustment.from_json(l.get("surcharge")),
                )
                for l in d["lines"]
            ],
            payment_terms=d.get("payment_terms"),
            order_number=d.get("order_number"),
            cancels_number=d.get("cancels_number"),
            discount=Adjustment.from_json(d.get("discount")),
            installments=[Installment.from_json(x) for x in d.get("installments") or []],
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

    def _allowance_category(self, rate_bp: int) -> str:
        if self.is_kleinunternehmer:
            return "E"
        return "Z" if rate_bp == 0 else "S"

    def _compute(self) -> None:
        net_by_rate: dict[int, int] = {}
        for line in self.lines:
            line.base_cents = round_div(line.quantity_milli * line.unit_price_net_cents, 1000)
            _, rate = self.line_category(line)
            line.discount_cents = line.discount.amount(line.base_cents) if line.discount else 0
            line.surcharge_cents = line.surcharge.amount(line.base_cents) if line.surcharge else 0
            line.net_cents = line.base_cents - line.discount_cents + line.surcharge_cents
            net_by_rate[rate] = net_by_rate.get(rate, 0) + line.net_cents

        self.line_net_sum_cents = sum(net_by_rate.values())

        # Rechnungsweiter Rabatt (BG-20) anteilig je Steuersatz auf die Basis anrechnen.
        # Der Rundungsrest landet auf dem umsatzstärksten Satz -> Summe exakt.
        self.invoice_discount_cents = 0
        self.allowances_by_rate = []
        if self.discount and self.line_net_sum_cents > 0:
            total = min(self.discount.amount(self.line_net_sum_cents), self.line_net_sum_cents)
            if total > 0:
                self.invoice_discount_cents = total
                rates = sorted(net_by_rate)
                alloc = {
                    r: round_div(total * net_by_rate[r], self.line_net_sum_cents) for r in rates
                }
                diff = total - sum(alloc.values())
                if diff != 0:
                    biggest = max(rates, key=lambda r: net_by_rate[r])
                    alloc[biggest] += diff
                for r in rates:
                    a = alloc[r]
                    net_by_rate[r] -= a
                    if a != 0:
                        self.allowances_by_rate.append(
                            DocAllowance(self._allowance_category(r), r, a)
                        )

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
