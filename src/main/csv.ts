/** CSV-Serialisierung für Exporte: Semikolon (deutsches Excel), CRLF, RFC-4180-Quoting. */

function esc(value: string): string {
  return /[";\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvLine(values: unknown[]): string {
  return values
    .map((v) => (v === null || v === undefined ? "" : esc(String(v))))
    .join(";");
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [csvLine(header), ...rows.map(csvLine)].join("\r\n") + "\r\n";
}

/** UTF-8-BOM, damit Excel Umlaute korrekt darstellt. */
export const CSV_BOM = "﻿";
