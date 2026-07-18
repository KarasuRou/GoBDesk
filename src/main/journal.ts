/** Serialisierung des Journals für den Prüfer-Export (CSV/JSON). */

import type { JournalEntry } from "../shared/api.js";
import { toCsv } from "./csv.js";

export function journalToJson(entries: JournalEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

export function journalToCsv(entries: JournalEntry[]): string {
  return toCsv(
    ["Nr", "Zeitpunkt", "Vorgang", "Beleg", "Details", "Verkettung", "record_hash"],
    entries.map((e) => [
      e.id,
      e.at,
      `${e.entityType}/${e.action}`,
      e.reference ?? "",
      e.summary,
      e.chainOk ? "ok" : "GEBROCHEN",
      e.recordHash,
    ]),
  );
}
