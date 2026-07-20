/**
 * Steuer-Engine: Kleinunternehmer (§19 UStG) vs. Regelbesteuerung.
 * Portierung von src-tauri/src/tax.rs.
 *
 * Konventionen: Geld in Cent, Steuersatz in Basispunkten (1900 = 19 %),
 * Menge in Tausendstel (1000 = 1,000 Einheiten). Prozentuale Zu-/Abschläge
 * werden ebenfalls in Basispunkten geführt (3000 = 30 %).
 */

export const KLEINUNTERNEHMER_HINWEIS =
  "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";

/** Erfassungsart eines Zu-/Abschlags: prozentual (Wert in bp) oder absolut (Cent). */
export type AdjustmentType = "percent" | "amount";

/** Ein Zu- oder Abschlag (Rabatt/Aufpreis). */
export interface Adjustment {
  type: AdjustmentType;
  /** percent → Basispunkte (3000 = 30 %); amount → Cent. */
  value: number;
  reason?: string | null;
}

export interface LineInput {
  quantityMilli: number;
  unitPriceNetCents: number;
  taxRateBp: number;
  /** Positions-Rabatt (EN 16931 BG-27, Allowance). */
  discount?: Adjustment | null;
  /** Positions-Aufpreis (EN 16931 BG-28, Charge). */
  surcharge?: Adjustment | null;
}

export interface LineResult {
  effectiveTaxRateBp: number;
  /** Positionsbasis = Menge × Einzelpreis, vor Zu-/Abschlag. */
  baseCents: number;
  /** Rabattbetrag (Allowance) dieser Position. */
  discountCents: number;
  /** Aufpreisbetrag (Charge) dieser Position. */
  surchargeCents: number;
  /** Positions-Netto nach Zu-/Abschlag (EN 16931 BT-131). */
  netCents: number;
}

export interface TaxBreakdownRow {
  taxRateBp: number;
  /** Steuerbasis je Satz nach Rechnungs-Rabatt (EN 16931 BT-116). */
  netCents: number;
  taxCents: number;
}

/** Aufteilung des rechnungsweiten Rabatts je Steuersatz (EN 16931 BG-20). */
export interface AllowanceByRate {
  taxRateBp: number;
  amountCents: number;
}

export interface InvoiceTotals {
  isKleinunternehmer: boolean;
  lines: LineResult[];
  breakdown: TaxBreakdownRow[];
  /** Summe der Positions-Nettobeträge vor Rechnungs-Rabatt (EN 16931 BT-106). */
  lineNetSumCents: number;
  /** Rechnungsweiter Rabatt gesamt (EN 16931 BT-107). */
  invoiceDiscountCents: number;
  /** Aufteilung des Rechnungs-Rabatts je Steuersatz (EN 16931 BG-20). */
  allowancesByRate: AllowanceByRate[];
  /** Steuerbasis gesamt = BT-106 − BT-107 (EN 16931 BT-109). */
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

/** Betrag eines Zu-/Abschlags bezogen auf eine Basis (in Cent). */
export function adjustmentAmount(
  adj: Adjustment | null | undefined,
  baseCents: number,
): number {
  if (!adj) return 0;
  return adj.type === "percent" ? roundDiv(baseCents * adj.value, 10_000) : adj.value;
}

/**
 * USt wird gemäß EN 16931 je Steuersatz auf die Netto-Summe berechnet
 * (nicht je Zeile) – vermeidet Rundungsdifferenzen zum Steuerausweis.
 *
 * Positions-Zu-/Abschläge fließen in das Positions-Netto (BT-131) ein, ein
 * rechnungsweiter Rabatt (BG-20) wird anteilig je Steuersatz auf die
 * Steuerbasis angerechnet – so bleibt der Ausweis EN-16931-konsistent.
 */
export function computeInvoiceTotals(
  lines: LineInput[],
  isKleinunternehmer: boolean,
  invoiceDiscount?: Adjustment | null,
): InvoiceTotals {
  const lineResults: LineResult[] = [];
  const netByRate = new Map<number, number>();

  for (const line of lines) {
    const baseCents = roundDiv(line.quantityMilli * line.unitPriceNetCents, 1000);
    const rate = isKleinunternehmer ? 0 : line.taxRateBp;
    const discountCents = adjustmentAmount(line.discount, baseCents);
    const surchargeCents = adjustmentAmount(line.surcharge, baseCents);
    const netCents = baseCents - discountCents + surchargeCents;
    netByRate.set(rate, (netByRate.get(rate) ?? 0) + netCents);
    lineResults.push({ effectiveTaxRateBp: rate, baseCents, discountCents, surchargeCents, netCents });
  }

  const lineNetSumCents = [...netByRate.values()].reduce((a, b) => a + b, 0);

  // Rechnungsweiter Rabatt (BG-20) anteilig je Steuersatz aufteilen, damit die
  // Steuerbasis je Satz stimmt. Die Rundungsdifferenz landet auf dem
  // umsatzstärksten Satz, sodass die Summe der Anteile exakt dem Rabatt entspricht.
  let invoiceDiscountCents = 0;
  const allowancesByRate: AllowanceByRate[] = [];
  if (invoiceDiscount && lineNetSumCents > 0) {
    const total = Math.min(
      adjustmentAmount(invoiceDiscount, lineNetSumCents),
      lineNetSumCents,
    );
    if (total > 0) {
      invoiceDiscountCents = total;
      const rates = [...netByRate.keys()].sort((a, b) => a - b);
      const alloc = new Map<number, number>();
      let allocated = 0;
      for (const rate of rates) {
        const a = roundDiv(total * netByRate.get(rate)!, lineNetSumCents);
        alloc.set(rate, a);
        allocated += a;
      }
      const diff = total - allocated;
      if (diff !== 0) {
        const biggest = rates.reduce(
          (m, r) => (netByRate.get(r)! > netByRate.get(m)! ? r : m),
          rates[0],
        );
        alloc.set(biggest, alloc.get(biggest)! + diff);
      }
      for (const rate of rates) {
        const a = alloc.get(rate)!;
        netByRate.set(rate, netByRate.get(rate)! - a);
        if (a !== 0) allowancesByRate.push({ taxRateBp: rate, amountCents: a });
      }
    }
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
    lineNetSumCents,
    invoiceDiscountCents,
    allowancesByRate,
    netTotalCents: netTotal,
    taxTotalCents: taxTotal,
    grossTotalCents: netTotal + taxTotal,
    legalNote: isKleinunternehmer ? KLEINUNTERNEHMER_HINWEIS : null,
  };
}
