import { describe, expect, test } from "bun:test";
import { backupsToPrune, exportKey } from "./backup";

/** The nightly Backups from `from` to `to`, both included, one per day. */
function nightly(from: string, to: string): string[] {
  const keys: string[] = [];
  for (
    let day = new Date(`${from}T00:00:00Z`);
    day <= new Date(`${to}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 1)
  ) {
    keys.push(exportKey(day.toISOString().slice(0, 10)));
  }
  return keys;
}

describe("backupsToPrune", () => {
  test("beyond the newest 30, a Backup goes unless it is its month's earliest", () => {
    expect(backupsToPrune(nightly("2026-10-01", "2026-11-01"))).toEqual(["exports/2026-10-02.json"]);
  });

  test("a month whose 1st was missed keeps the earliest Backup it has", () => {
    const keys = [
      exportKey("2026-08-03"),
      exportKey("2026-08-20"),
      exportKey("2026-09-05"),
      ...nightly("2026-09-06", "2026-10-05"),
    ];

    expect(backupsToPrune(keys)).toEqual(["exports/2026-08-20.json"]);
  });

  test("a stopped nightly export deletes nothing, however old the newest 30 are", () => {
    expect(backupsToPrune(nightly("2025-01-01", "2025-01-30"))).toEqual([]);
  });

  test("a file put under exports/ by hand is never pruned", () => {
    const keys = ["exports/before-migration.json", ...nightly("2026-10-01", "2026-11-01")];

    expect(backupsToPrune(keys)).toEqual(["exports/2026-10-02.json"]);
  });
});
