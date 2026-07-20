import { describe, expect, it } from "vitest";

import {
  adjustmentAmount,
  computeInvoiceTotals,
  KLEINUNTERNEHMER_HINWEIS,
  roundDiv,
} from "../src/core/tax";

describe("roundDiv (kaufmännische Rundung, half away from zero)", () => {
  it("rundet .5 vom Nullpunkt weg", () => {
    expect(roundDiv(5, 2)).toBe(3); // 2,5 -> 3
    expect(roundDiv(7, 2)).toBe(4); // 3,5 -> 4
    expect(roundDiv(-5, 2)).toBe(-3); // -2,5 -> -3
    expect(roundDiv(-7, 2)).toBe(-4);
  });

  it("rundet normal und teilt glatt", () => {
    expect(roundDiv(10, 3)).toBe(3); // 3,33 -> 3
    expect(roundDiv(11, 3)).toBe(4); // 3,67 -> 4
    expect(roundDiv(100, 10)).toBe(10);
    expect(roundDiv(0, 7)).toBe(0);
  });

  it("negative, exakt teilbare Beträge bleiben exakt (Storno-Regression)", () => {
    // Menge -1 × 200,00 € netto: -1000 * 20000 / 1000 muss exakt -20000 sein
    // (Floor-Division würde -20001 liefern – der 1-Cent-Bug im Sidecar).
    expect(roundDiv(-1000 * 20000, 1000)).toBe(-20000);
    expect(roundDiv(-10_000_000, 1000)).toBe(-10000);
    expect(roundDiv(-19_000_000, 10_000)).toBe(-1900);
  });

  it("Stornosummen sind exakt das Negativ der Originalsummen", () => {
    const original = computeInvoiceTotals(
      [
        { quantityMilli: 1000, unitPriceNetCents: 20000, taxRateBp: 1900 },
        { quantityMilli: 2500, unitPriceNetCents: 3333, taxRateBp: 700 },
      ],
      false,
    );
    const storno = computeInvoiceTotals(
      [
        { quantityMilli: -1000, unitPriceNetCents: 20000, taxRateBp: 1900 },
        { quantityMilli: -2500, unitPriceNetCents: 3333, taxRateBp: 700 },
      ],
      false,
    );
    expect(storno.netTotalCents).toBe(-original.netTotalCents);
    expect(storno.taxTotalCents).toBe(-original.taxTotalCents);
    expect(storno.grossTotalCents).toBe(-original.grossTotalCents);
  });
});

describe("computeInvoiceTotals – Regelbesteuerung", () => {
  it("berechnet eine Position mit 19 %", () => {
    const t = computeInvoiceTotals(
      [{ quantityMilli: 1000, unitPriceNetCents: 10000, taxRateBp: 1900 }],
      false,
    );
    expect(t.netTotalCents).toBe(10000);
    expect(t.taxTotalCents).toBe(1900);
    expect(t.grossTotalCents).toBe(11900);
    expect(t.legalNote).toBeNull();
  });

  it("weist USt je Steuersatz getrennt aus (19 % + 7 %)", () => {
    const t = computeInvoiceTotals(
      [
        { quantityMilli: 1000, unitPriceNetCents: 9000, taxRateBp: 1900 },
        { quantityMilli: 2000, unitPriceNetCents: 2500, taxRateBp: 700 },
      ],
      false,
    );
    expect(t.netTotalCents).toBe(14000);
    expect(t.taxTotalCents).toBe(1710 + 350);
    expect(t.grossTotalCents).toBe(16060);
    // Aufschlüsselung nach Satz sortiert (7 % vor 19 %)
    expect(t.breakdown).toEqual([
      { taxRateBp: 700, netCents: 5000, taxCents: 350 },
      { taxRateBp: 1900, netCents: 9000, taxCents: 1710 },
    ]);
  });

  it("berechnet USt je Satz auf die Netto-Summe, nicht je Zeile (EN 16931)", () => {
    // Zwei Zeilen à 333 ct @ 19 %: je Zeile 63 (Summe 126), auf die Summe 666 -> 127.
    const t = computeInvoiceTotals(
      [
        { quantityMilli: 1000, unitPriceNetCents: 333, taxRateBp: 1900 },
        { quantityMilli: 1000, unitPriceNetCents: 333, taxRateBp: 1900 },
      ],
      false,
    );
    expect(t.netTotalCents).toBe(666);
    expect(t.taxTotalCents).toBe(127);
  });
});

describe("computeInvoiceTotals – Kleinunternehmer (§19 UStG)", () => {
  it("setzt jeden Satz auf 0, keine USt, mit Rechtshinweis", () => {
    const t = computeInvoiceTotals(
      [
        { quantityMilli: 1000, unitPriceNetCents: 9000, taxRateBp: 1900 },
        { quantityMilli: 2000, unitPriceNetCents: 2500, taxRateBp: 700 },
      ],
      true,
    );
    expect(t.netTotalCents).toBe(14000);
    expect(t.taxTotalCents).toBe(0);
    expect(t.grossTotalCents).toBe(14000);
    expect(t.breakdown).toEqual([{ taxRateBp: 0, netCents: 14000, taxCents: 0 }]);
    expect(t.lines.every((l) => l.effectiveTaxRateBp === 0)).toBe(true);
    expect(t.legalNote).toBe(KLEINUNTERNEHMER_HINWEIS);
  });
});

describe("adjustmentAmount", () => {
  it("prozentual rechnet in Basispunkten auf die Basis", () => {
    expect(adjustmentAmount({ type: "percent", value: 3000 }, 10000)).toBe(3000); // 30 %
    expect(adjustmentAmount({ type: "percent", value: 700 }, 3333)).toBe(233); // 7 % kaufm. gerundet
  });
  it("absolut liefert den Cent-Betrag unverändert", () => {
    expect(adjustmentAmount({ type: "amount", value: 1500 }, 10000)).toBe(1500);
  });
  it("ohne Zu-/Abschlag ist der Betrag 0", () => {
    expect(adjustmentAmount(null, 10000)).toBe(0);
    expect(adjustmentAmount(undefined, 10000)).toBe(0);
  });
});

describe("computeInvoiceTotals – Positions-Zu-/Abschläge (BG-27/BG-28)", () => {
  it("Aufpreis +30 % auf eine Position (Animation-Beispiel)", () => {
    const t = computeInvoiceTotals(
      [
        {
          quantityMilli: 1000,
          unitPriceNetCents: 10000,
          taxRateBp: 1900,
          surcharge: { type: "percent", value: 3000, reason: "Animation" },
        },
      ],
      false,
    );
    expect(t.lines[0]).toMatchObject({
      baseCents: 10000,
      discountCents: 0,
      surchargeCents: 3000,
      netCents: 13000,
    });
    expect(t.lineNetSumCents).toBe(13000);
    expect(t.netTotalCents).toBe(13000);
    expect(t.taxTotalCents).toBe(2470);
    expect(t.grossTotalCents).toBe(15470);
  });

  it("absoluter Positions-Rabatt reduziert das Positions-Netto", () => {
    const t = computeInvoiceTotals(
      [
        {
          quantityMilli: 1000,
          unitPriceNetCents: 10000,
          taxRateBp: 1900,
          discount: { type: "amount", value: 1500 },
        },
      ],
      false,
    );
    expect(t.lines[0]).toMatchObject({ baseCents: 10000, discountCents: 1500, netCents: 8500 });
    expect(t.netTotalCents).toBe(8500);
    expect(t.taxTotalCents).toBe(1615);
    expect(t.grossTotalCents).toBe(10115);
  });

  it("Rabatt und Aufpreis auf derselben Position: Netto = Basis − Rabatt + Aufpreis", () => {
    const t = computeInvoiceTotals(
      [
        {
          quantityMilli: 1000,
          unitPriceNetCents: 10000,
          taxRateBp: 1900,
          discount: { type: "percent", value: 1000 }, // −10 % = −1000
          surcharge: { type: "amount", value: 500 }, // +500 ct
        },
      ],
      false,
    );
    expect(t.lines[0]).toMatchObject({ baseCents: 10000, discountCents: 1000, surchargeCents: 500, netCents: 9500 });
    expect(t.netTotalCents).toBe(9500);
  });
});

describe("computeInvoiceTotals – Rechnungs-Rabatt (BG-20)", () => {
  it("prozentualer Rabatt wird je Steuersatz anteilig verrechnet (19 % + 7 %)", () => {
    const t = computeInvoiceTotals(
      [
        { quantityMilli: 1000, unitPriceNetCents: 10000, taxRateBp: 1900 },
        { quantityMilli: 1000, unitPriceNetCents: 5000, taxRateBp: 700 },
      ],
      false,
      { type: "percent", value: 1000 }, // −10 %
    );
    expect(t.lineNetSumCents).toBe(15000);
    expect(t.invoiceDiscountCents).toBe(1500);
    expect(t.allowancesByRate).toEqual([
      { taxRateBp: 700, amountCents: 500 },
      { taxRateBp: 1900, amountCents: 1000 },
    ]);
    // reduzierte Steuerbasis je Satz
    expect(t.breakdown).toEqual([
      { taxRateBp: 700, netCents: 4500, taxCents: 315 },
      { taxRateBp: 1900, netCents: 9000, taxCents: 1710 },
    ]);
    expect(t.netTotalCents).toBe(13500);
    expect(t.taxTotalCents).toBe(2025);
    expect(t.grossTotalCents).toBe(15525);
  });

  it("absoluter Rabatt: Rundungsrest landet exakt beim umsatzstärksten Satz", () => {
    const t = computeInvoiceTotals(
      [
        { quantityMilli: 1000, unitPriceNetCents: 10000, taxRateBp: 1900 },
        { quantityMilli: 1000, unitPriceNetCents: 10000, taxRateBp: 700 },
      ],
      false,
      { type: "amount", value: 999 },
    );
    expect(t.invoiceDiscountCents).toBe(999);
    const sum = t.allowancesByRate.reduce((s, a) => s + a.amountCents, 0);
    expect(sum).toBe(999); // Aufteilung ist exakt, kein verlorener Cent
    expect(t.netTotalCents).toBe(20000 - 999);
  });

  it("Kleinunternehmer: Rabatt reduziert die (steuerfreie) Basis, keine USt", () => {
    const t = computeInvoiceTotals(
      [
        { quantityMilli: 1000, unitPriceNetCents: 10000, taxRateBp: 1900 },
        { quantityMilli: 1000, unitPriceNetCents: 5000, taxRateBp: 700 },
      ],
      true,
      { type: "percent", value: 1000 },
    );
    expect(t.invoiceDiscountCents).toBe(1500);
    expect(t.allowancesByRate).toEqual([{ taxRateBp: 0, amountCents: 1500 }]);
    expect(t.breakdown).toEqual([{ taxRateBp: 0, netCents: 13500, taxCents: 0 }]);
    expect(t.netTotalCents).toBe(13500);
    expect(t.taxTotalCents).toBe(0);
    expect(t.legalNote).toBe(KLEINUNTERNEHMER_HINWEIS);
  });
});
