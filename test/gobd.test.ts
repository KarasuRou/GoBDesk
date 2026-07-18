import { createHash } from "node:crypto";

import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { formatBuyerAddress, invoiceContentHash, verifyAuditChain } from "../src/core/gobd";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

interface AuditRow {
  id: number;
  payload_json: string;
  prev_hash: string;
  record_hash: string;
}

/** Baut eine korrekt verkettete Audit-Kette (wie `appendAudit` sie erzeugt). */
function buildChain(payloads: string[]): AuditRow[] {
  const rows: AuditRow[] = [];
  let prev = "";
  payloads.forEach((payload, i) => {
    const record = sha(`${prev}|${payload}`);
    rows.push({ id: i + 1, payload_json: payload, prev_hash: prev, record_hash: record });
    prev = record;
  });
  return rows;
}

/** Minimal-DB-Attrappe: verifyAuditChain nutzt nur prepare().all(). */
function fakeDb(rows: AuditRow[]): Database.Database {
  return { prepare: () => ({ all: () => rows }) } as unknown as Database.Database;
}

describe("verifyAuditChain", () => {
  it("akzeptiert eine intakte Kette", () => {
    expect(verifyAuditChain(fakeDb(buildChain(["a", "b", "c"])))).toBeNull();
    expect(verifyAuditChain(fakeDb([]))).toBeNull();
  });

  it("erkennt einen manipulierten Payload (record_hash passt nicht mehr)", () => {
    const rows = buildChain(["a", "b", "c"]);
    rows[1].payload_json = '{"tampered":true}'; // record_hash bleibt alt -> Bruch
    expect(verifyAuditChain(fakeDb(rows))).toBe(2);
  });

  it("erkennt eine unterbrochene Verkettung (prev_hash falsch)", () => {
    const rows = buildChain(["a", "b", "c"]);
    rows[2].prev_hash = sha("fremd"); // Vorgänger-Verweis stimmt nicht
    expect(verifyAuditChain(fakeDb(rows))).toBe(3);
  });

  it("erkennt einen entfernten Eintrag (Kette rutscht auseinander)", () => {
    const rows = buildChain(["a", "b", "c"]);
    rows.splice(1, 1); // Eintrag 2 gelöscht -> id 3 hat falschen prev_hash
    expect(verifyAuditChain(fakeDb(rows))).toBe(3);
  });
});

describe("invoiceContentHash", () => {
  const base = {
    number: "2026-0001",
    issueDate: "2026-01-01",
    customerId: 1,
    customerName: "Muster GmbH",
    netTotalCents: 10000,
    taxTotalCents: 1900,
    grossTotalCents: 11900,
    isKleinunternehmer: false,
  };

  it("ist deterministisch", () => {
    expect(invoiceContentHash({ ...base, version: 2, orderNumber: "2026-A0001" })).toBe(
      invoiceContentHash({ ...base, version: 2, orderNumber: "2026-A0001" }),
    );
  });

  it("v1 ignoriert die Auftragsnummer (Abwärtskompatibilität für Altbelege)", () => {
    expect(invoiceContentHash({ ...base, version: 1 })).toBe(
      invoiceContentHash({ ...base, version: 1, orderNumber: "2026-A0001" }),
    );
  });

  it("v2 bezieht die Auftragsnummer in den Hash ein", () => {
    expect(invoiceContentHash({ ...base, version: 2, orderNumber: "2026-A0001" })).not.toBe(
      invoiceContentHash({ ...base, version: 2, orderNumber: null }),
    );
  });

  it("reagiert auf geänderte Kerndaten (z. B. Betrag)", () => {
    expect(invoiceContentHash({ ...base, version: 2 })).not.toBe(
      invoiceContentHash({ ...base, version: 2, grossTotalCents: 12000 }),
    );
  });

  it("v2 ignoriert die Storno-Referenz (Abwärtskompatibilität)", () => {
    expect(invoiceContentHash({ ...base, version: 2 })).toBe(
      invoiceContentHash({ ...base, version: 2, cancelsNumber: "2026-0001" }),
    );
  });

  it("v3 friert die Storno-Referenz im Hash ein", () => {
    expect(invoiceContentHash({ ...base, version: 3, cancelsNumber: "2026-0001" })).not.toBe(
      invoiceContentHash({ ...base, version: 3, cancelsNumber: null }),
    );
  });

  it("v3 ignoriert die Käuferanschrift (Abwärtskompatibilität)", () => {
    expect(invoiceContentHash({ ...base, version: 3 })).toBe(
      invoiceContentHash({ ...base, version: 3, buyerAddress: "Musterstr. 1, 12345 Berlin, DE" }),
    );
  });

  it("v4 friert die Käuferanschrift im Hash ein", () => {
    expect(
      invoiceContentHash({ ...base, version: 4, buyerAddress: "Musterstr. 1, 12345 Berlin, DE" }),
    ).not.toBe(invoiceContentHash({ ...base, version: 4, buyerAddress: null }));
  });

  it("v3 funktioniert mit negativen Beträgen (Stornobeleg)", () => {
    const storno = invoiceContentHash({
      ...base,
      version: 3,
      netTotalCents: -10000,
      taxTotalCents: -1900,
      grossTotalCents: -11900,
      cancelsNumber: "2026-0001",
    });
    expect(storno).toMatch(/^[0-9a-f]{64}$/);
    expect(storno).toBe(
      invoiceContentHash({
        ...base,
        version: 3,
        netTotalCents: -10000,
        taxTotalCents: -1900,
        grossTotalCents: -11900,
        cancelsNumber: "2026-0001",
      }),
    );
  });
});

describe("formatBuyerAddress", () => {
  it("baut eine deterministische, einzeilige Anschrift", () => {
    expect(
      formatBuyerAddress({
        address_line1: "Musterstr. 1",
        address_line2: null,
        zip: "12345",
        city: "Berlin",
        country_iso: "DE",
      }),
    ).toBe("Musterstr. 1, 12345 Berlin, DE");
  });

  it("lässt fehlende Bestandteile aus", () => {
    expect(formatBuyerAddress({ city: "Berlin", country_iso: "DE" })).toBe("Berlin, DE");
    expect(formatBuyerAddress({})).toBeNull();
  });
});
