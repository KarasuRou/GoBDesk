/**
 * Steuer-Engine: Kleinunternehmer (§19 UStG) vs. Regelbesteuerung.
 * Portierung von src-tauri/src/tax.rs.
 *
 * Konventionen: Geld in Cent, Steuersatz in Basispunkten (1900 = 19 %),
 * Menge in Tausendstel (1000 = 1,000 Einheiten).
 */

export const KLEINUNTERNEHMER_HINWEIS =
  "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";

export interface LineInput {
  quantityMilli: number;
  unitPriceNetCents: number;
  taxRateBp: number;
}

export interface LineResult {
  effectiveTaxRateBp: number;
  netCents: number;
}

export interface TaxBreakdownRow {
  taxRateBp: number;
  netCents: number;
  taxCents: number;
}

export interface InvoiceTotals {
  isKleinunternehmer: boolean;
  lines: LineResult[];
  breakdown: TaxBreakdownRow[];
  netTotalCents: number;
  taxTotalCents: number;
  grossTotalCents: number;
  legalNote: string | null;
}

/** Kaufmännische Rundung (round half away from zero), ganzzahlig. */
export function roundDiv(numerator: number, denominator: number): number {
  const half = Math.trunc(denominator / 2);
  return numerator >= 0
    ? Math.trunc((numerator + half) / denominator)
    : Math.trunc((numerator - half) / denominator);
}

/**
 * USt wird gemäß EN 16931 je Steuersatz auf die Netto-Summe berechnet
 * (nicht je Zeile) – vermeidet Rundungsdifferenzen zum Steuerausweis.
 */
export function computeInvoiceTotals(
  lines: LineInput[],
  isKleinunternehmer: boolean,
): InvoiceTotals {
  const lineResults: LineResult[] = [];
  const netByRate = new Map<number, number>();

  for (const line of lines) {
    const netCents = roundDiv(line.quantityMilli * line.unitPriceNetCents, 1000);
    const rate = isKleinunternehmer ? 0 : line.taxRateBp;
    netByRate.set(rate, (netByRate.get(rate) ?? 0) + netCents);
    lineResults.push({ effectiveTaxRateBp: rate, netCents });
  }

  const breakdown: TaxBreakdownRow[] = [];
  let netTotal = 0;
  let taxTotal = 0;
  for (const rateBp of [...netByRate.keys()].sort((a, b) => a - b)) {
    const netCents = netByRate.get(rateBp)!;
    const taxCents = roundDiv(netCents * rateBp, 10_000);
    breakdown.push({ taxRateBp: rateBp, netCents, taxCents });
    netTotal += netCents;
    taxTotal += taxCents;
  }

  return {
    isKleinunternehmer,
    lines: lineResults,
    breakdown,
    netTotalCents: netTotal,
    taxTotalCents: taxTotal,
    grossTotalCents: netTotal + taxTotal,
    legalNote: isKleinunternehmer ? KLEINUNTERNEHMER_HINWEIS : null,
  };
}
