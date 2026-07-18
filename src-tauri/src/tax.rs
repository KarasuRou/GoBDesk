//! Steuer-Engine: Kleinunternehmer (§19 UStG) vs. Regelbesteuerung.
//!
//! Konventionen (siehe auch db/migrations/0001_init.sql):
//!   * Geldbeträge in Cent (i64).
//!   * Steuersätze in Basispunkten (bp): 19,00 % = 1900.
//!   * Mengen in Tausendstel (milli): 1,000 Einheiten = 1000.
//!
//! Reine Logik ohne DB-Abhängigkeit -> vollständig unit-testbar.

use std::collections::BTreeMap;

/// Pflichthinweis für Kleinunternehmer nach §19 UStG.
pub const KLEINUNTERNEHMER_HINWEIS: &str =
    "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.";

#[derive(Clone, Copy, Debug)]
pub struct TaxContext {
    pub is_kleinunternehmer: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct LineInput {
    pub quantity_milli: i64,
    pub unit_price_net_cents: i64,
    /// Wird im KU-Modus auf 0 gezwungen.
    pub tax_rate_bp: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineResult {
    pub effective_tax_rate_bp: i32,
    pub net_cents: i64,
}

/// Steueraufschlüsselung je Satz – Basis für Rechnungsausweis und UStVA.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaxBreakdownRow {
    pub tax_rate_bp: i32,
    pub net_cents: i64,
    pub tax_cents: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InvoiceTotals {
    pub is_kleinunternehmer: bool,
    pub lines: Vec<LineResult>,
    pub breakdown: Vec<TaxBreakdownRow>,
    pub net_total_cents: i64,
    pub tax_total_cents: i64,
    pub gross_total_cents: i64,
    pub legal_note: Option<String>,
}

/// Kaufmännische Rundung (round half away from zero). i128 gegen Überlauf.
fn round_div(numerator: i128, denominator: i128) -> i64 {
    debug_assert!(denominator > 0);
    let half = denominator / 2;
    let result = if numerator >= 0 {
        (numerator + half) / denominator
    } else {
        (numerator - half) / denominator
    };
    result as i64
}

pub fn compute_line(line: &LineInput, ctx: &TaxContext) -> LineResult {
    let net = round_div(
        line.quantity_milli as i128 * line.unit_price_net_cents as i128,
        1000,
    );
    let rate = if ctx.is_kleinunternehmer { 0 } else { line.tax_rate_bp };
    LineResult { effective_tax_rate_bp: rate, net_cents: net }
}

/// Berechnet Summen und Steueraufschlüsselung einer Rechnung.
///
/// Die USt wird gemäß EN 16931 je Steuersatz auf die Netto-Summe berechnet
/// (nicht je Zeile) – das vermeidet Rundungsdifferenzen gegenüber dem
/// separaten Steuerausweis auf der Rechnung.
pub fn compute_invoice_totals(lines: &[LineInput], ctx: &TaxContext) -> InvoiceTotals {
    let mut line_results = Vec::with_capacity(lines.len());
    let mut net_by_rate: BTreeMap<i32, i64> = BTreeMap::new();

    for line in lines {
        let res = compute_line(line, ctx);
        *net_by_rate.entry(res.effective_tax_rate_bp).or_default() += res.net_cents;
        line_results.push(res);
    }

    let mut breakdown = Vec::new();
    let (mut net_total, mut tax_total) = (0i64, 0i64);
    for (&rate_bp, &net) in &net_by_rate {
        let tax = round_div(net as i128 * rate_bp as i128, 10_000);
        breakdown.push(TaxBreakdownRow { tax_rate_bp: rate_bp, net_cents: net, tax_cents: tax });
        net_total += net;
        tax_total += tax;
    }

    let legal_note = if ctx.is_kleinunternehmer {
        Some(KLEINUNTERNEHMER_HINWEIS.to_string())
    } else {
        None
    };

    InvoiceTotals {
        is_kleinunternehmer: ctx.is_kleinunternehmer,
        lines: line_results,
        breakdown,
        net_total_cents: net_total,
        tax_total_cents: tax_total,
        gross_total_cents: net_total + tax_total,
        legal_note,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(qty_milli: i64, price: i64, rate: i32) -> LineInput {
        LineInput { quantity_milli: qty_milli, unit_price_net_cents: price, tax_rate_bp: rate }
    }

    #[test]
    fn regelbesteuerung_weist_ust_getrennt_aus() {
        let ctx = TaxContext { is_kleinunternehmer: false };
        // 2 x 100,00 € @ 19 %  +  1 x 50,00 € @ 7 %
        let lines = [line(2000, 10_000, 1900), line(1000, 5_000, 700)];
        let t = compute_invoice_totals(&lines, &ctx);

        assert_eq!(t.net_total_cents, 25_000);
        assert_eq!(t.tax_total_cents, 3_800 + 350); // 38,00 + 3,50
        assert_eq!(t.gross_total_cents, 29_150);
        assert_eq!(t.breakdown.len(), 2);
        assert!(t.legal_note.is_none());
    }

    #[test]
    fn kleinunternehmer_erzwingt_null_prozent_und_hinweis() {
        let ctx = TaxContext { is_kleinunternehmer: true };
        // Satz 19 wird ignoriert -> 0 %
        let lines = [line(1000, 10_000, 1900)];
        let t = compute_invoice_totals(&lines, &ctx);

        assert_eq!(t.tax_total_cents, 0);
        assert_eq!(t.gross_total_cents, 10_000);
        assert_eq!(t.breakdown[0].tax_rate_bp, 0);
        assert_eq!(t.legal_note.as_deref(), Some(KLEINUNTERNEHMER_HINWEIS));
    }
}
