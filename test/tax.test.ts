import { describe, expect, it } from "vitest";

import { computeInvoiceTotals, KLEINUNTERNEHMER_HINWEIS, roundDiv } from "../src/core/tax";

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
