//! GoBD-Kernlogik: Festschreibung von Rechnungen und revisionssichere
//! Audit-Kette. Bewusst im kompilierten Rust-Core (nicht im Sidecar), damit
//! die integritätskritische Logik schwerer zu manipulieren ist.
//!
//! Abhängigkeiten (Cargo.toml): rusqlite, sha2, hex, chrono, thiserror.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use sha2::{Digest, Sha256};

use crate::tax::{compute_invoice_totals, LineInput, TaxContext};

#[derive(Debug, thiserror::Error)]
pub enum GobdError {
    #[error("Rechnung {0} nicht gefunden")]
    NotFound(i64),
    #[error("Rechnung {0} ist bereits festgeschrieben und unveränderbar")]
    AlreadyIssued(i64),
    #[error("Rechnung {0} ist unvollständig: {1}")]
    Incomplete(i64, String),
    #[error(transparent)]
    Db(#[from] rusqlite::Error),
}

#[derive(Debug)]
pub struct IssueResult {
    pub invoice_id: i64,
    pub invoice_number: String,
    pub content_hash: String,
    pub audit_id: i64,
}

/// Schreibt eine Rechnung fest (draft -> issued). Läuft vollständig in einer
/// Transaktion: Nummernvergabe, Betragsberechnung, Hash und Audit-Eintrag
/// werden atomar committet oder gar nicht.
pub fn issue_invoice(conn: &mut Connection, invoice_id: i64) -> Result<IssueResult, GobdError> {
    let tx = conn.transaction()?;

    // 1) Status prüfen
    let status: Option<String> = tx
        .query_row("SELECT status FROM invoices WHERE id = ?1", [invoice_id], |r| r.get(0))
        .optional()?;
    match status.as_deref() {
        None => return Err(GobdError::NotFound(invoice_id)),
        Some("issued") | Some("cancelled") => return Err(GobdError::AlreadyIssued(invoice_id)),
        _ => {}
    }

    // 2) Steuermodus zum Zeitpunkt der Festschreibung EINFRIEREN (Snapshot).
    //    Ein späteres Umschalten des globalen Flags ändert Altbelege nicht.
    let is_ku: i64 = tx.query_row(
        "SELECT is_kleinunternehmer FROM company_settings WHERE id = 1",
        [],
        |r| r.get(0),
    )?;
    let ctx = TaxContext { is_kleinunternehmer: is_ku != 0 };

    // 3) Kopf-Pflichtfelder
    let (customer_id, service_date, issue_date): (i64, Option<String>, Option<String>) =
        tx.query_row(
            "SELECT customer_id, service_date, issue_date FROM invoices WHERE id = ?1",
            [invoice_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
    if service_date.is_none() {
        return Err(GobdError::Incomplete(invoice_id, "Leistungsdatum fehlt".into()));
    }
    let issue_date = issue_date.unwrap_or_else(today_iso);

    // 4) Positionen laden
    let lines = load_line_inputs(&tx, invoice_id)?;
    if lines.is_empty() {
        return Err(GobdError::Incomplete(invoice_id, "keine Positionen".into()));
    }

    // 5) Beträge berechnen (KU erzwingt 0 %, Regelbesteuerung je Satz getrennt)
    let totals = compute_invoice_totals(&lines, &ctx);

    // 6) Lückenlose Rechnungsnummer atomar vergeben
    let year = &issue_date[..4];
    let number = next_invoice_number(&tx, year)?;

    // 7) Kerndaten kanonisch (deterministisch!) serialisieren und hashen.
    //    Bewusst manueller String statt serde-Default, damit die Feldreihenfolge
    //    stabil bleibt – Grundlage für einen reproduzierbaren Hash.
    let customer_name: String = tx.query_row(
        "SELECT COALESCE(company_name, contact_last_name, '') FROM customers WHERE id = ?1",
        [customer_id],
        |r| r.get(0),
    )?;
    let canonical = format!(
        "v1|{number}|{issue_date}|{customer_id}|{customer_name}|{net}|{tax}|{gross}|ku={ku}",
        net = totals.net_total_cents,
        tax = totals.tax_total_cents,
        gross = totals.gross_total_cents,
        ku = ctx.is_kleinunternehmer as i32,
    );
    let content_hash = sha256_hex(canonical.as_bytes());

    // 8) Positionen einfrieren, SOLANGE die Rechnung noch 'draft' ist
    //    (der Sperr-Trigger auf invoice_items greift erst bei Status 'issued').
    let now = now_iso();
    freeze_line_amounts(&tx, invoice_id, &lines, &totals)?;

    //    ...danach die Rechnung selbst festschreiben.
    tx.execute(
        "UPDATE invoices SET
            status = 'issued',
            invoice_number = ?2,
            issue_date = ?3,
            is_kleinunternehmer_snapshot = ?4,
            net_total_cents = ?5,
            tax_total_cents = ?6,
            gross_total_cents = ?7,
            content_hash = ?8,
            issued_at = ?9,
            updated_at = ?9
         WHERE id = ?1",
        params![
            invoice_id,
            number,
            issue_date,
            ctx.is_kleinunternehmer as i32,
            totals.net_total_cents,
            totals.tax_total_cents,
            totals.gross_total_cents,
            content_hash,
            now,
        ],
    )?;

    // 9) Audit-Eintrag als Glied der Hash-Kette anhängen
    let audit_id = append_audit(&tx, invoice_id, "ISSUE", &number, &content_hash, &now)?;

    tx.commit()?;
    Ok(IssueResult { invoice_id, invoice_number: number, content_hash, audit_id })
}

fn load_line_inputs(tx: &Transaction, invoice_id: i64) -> Result<Vec<LineInput>, GobdError> {
    let mut stmt = tx.prepare(
        "SELECT quantity_milli, unit_price_net_cents, tax_rate_bp
           FROM invoice_items WHERE invoice_id = ?1 ORDER BY position",
    )?;
    let rows = stmt
        .query_map([invoice_id], |r| {
            Ok(LineInput {
                quantity_milli: r.get(0)?,
                unit_price_net_cents: r.get(1)?,
                tax_rate_bp: r.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Friert die berechneten Zeilenbeträge ein. Erfolgt VOR dem Status-Wechsel
/// auf 'issued' im selben Transaktionsschritt-Fluss (Trigger greift erst bei
/// bereits festgeschriebenem Status), daher hier separat kalkuliert.
fn freeze_line_amounts(
    tx: &Transaction,
    invoice_id: i64,
    lines: &[LineInput],
    totals: &crate::tax::InvoiceTotals,
) -> Result<(), GobdError> {
    let mut stmt = tx.prepare(
        "UPDATE invoice_items
            SET line_net_cents = ?2, line_tax_cents = ?3, line_gross_cents = ?4
          WHERE invoice_id = ?1 AND position = ?5",
    )?;
    for (idx, (line, res)) in lines.iter().zip(totals.lines.iter()).enumerate() {
        let net = res.net_cents;
        let tax = round_div(net as i128 * res.effective_tax_rate_bp as i128, 10_000);
        stmt.execute(params![invoice_id, net, tax, net + tax, (idx as i64) + 1])?;
        let _ = line; // Eingangsdaten bereits in res verrechnet
    }
    Ok(())
}

fn next_invoice_number(tx: &Transaction, year: &str) -> Result<String, GobdError> {
    tx.execute(
        "INSERT INTO number_sequences (scope, period, next_value)
         VALUES ('invoice', ?1, 1)
         ON CONFLICT(scope, period) DO UPDATE SET next_value = next_value + 1",
        [year],
    )?;
    let n: i64 = tx.query_row(
        "SELECT next_value FROM number_sequences WHERE scope = 'invoice' AND period = ?1",
        [year],
        |r| r.get(0),
    )?;
    Ok(format!("{year}-{n:04}"))
}

fn append_audit(
    tx: &Transaction,
    entity_id: i64,
    action: &str,
    number: &str,
    content_hash: &str,
    now: &str,
) -> Result<i64, GobdError> {
    let prev_hash: String = tx
        .query_row(
            "SELECT record_hash FROM audit_log ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or_default();

    let payload = format!(
        "{{\"entity\":\"invoice\",\"id\":{entity_id},\"action\":\"{action}\",\
          \"number\":\"{number}\",\"content_hash\":\"{content_hash}\",\"at\":\"{now}\"}}"
    );
    let record_hash = sha256_hex(format!("{prev_hash}|{payload}").as_bytes());

    tx.execute(
        "INSERT INTO audit_log
            (created_at, entity_type, entity_id, action, payload_json, prev_hash, record_hash)
         VALUES (?1, 'invoice', ?2, ?3, ?4, ?5, ?6)",
        params![now, entity_id, action, payload, prev_hash, record_hash],
    )?;
    Ok(tx.last_insert_rowid())
}

/// Prüft die Unversehrtheit der Audit-Kette. Gibt die id des ersten
/// gebrochenen Glieds zurück (None = Kette intakt).
pub fn verify_audit_chain(conn: &Connection) -> Result<Option<i64>, GobdError> {
    let mut stmt = conn.prepare(
        "SELECT id, payload_json, prev_hash, record_hash FROM audit_log ORDER BY id ASC",
    )?;
    let mut expected_prev = String::new();
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let id: i64 = row.get(0)?;
        let payload: String = row.get(1)?;
        let stored_prev: String = row.get(2)?;
        let stored_hash: String = row.get(3)?;

        if stored_prev != expected_prev {
            return Ok(Some(id));
        }
        let recomputed = sha256_hex(format!("{stored_prev}|{payload}").as_bytes());
        if recomputed != stored_hash {
            return Ok(Some(id));
        }
        expected_prev = stored_hash;
    }
    Ok(None)
}

fn round_div(numerator: i128, denominator: i128) -> i64 {
    let half = denominator / 2;
    let result = if numerator >= 0 {
        (numerator + half) / denominator
    } else {
        (numerator - half) / denominator
    };
    result as i64
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

fn today_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%d").to_string()
}
