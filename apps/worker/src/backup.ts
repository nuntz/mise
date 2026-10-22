import { EXPORT_FORMAT_VERSION, HouseholdExport } from "@mise/domain";
import { z } from "zod";
import { schemaVersion } from "./migrations";
import { parseStoredHousehold } from "./tools";

/**
 * Tables that are not Household data: SQLite's and Cloudflare's internals, the Agents SDK and
 * Pi harness tables, and our own bookkeeping. Every other table is exported, so new domain tables
 * are backed up without touching this file.
 */
const NOT_HOUSEHOLD_DATA = /^(sqlite_|_cf_|cf_|pi_)/;
const BOOKKEEPING = new Set(["schema_version", "revision"]);

export type RestoreError = {
  code: "invalid_export" | "schema_mismatch" | "not_empty";
  message: string;
};

export type RestoreResult = { ok: true } | { ok: false; error: RestoreError };

export function exportHousehold(sql: SqlStorage, photoKeys: string[]): HouseholdExport {
  const tables: HouseholdExport["tables"] = {};
  for (const table of householdTables(sql)) {
    tables[table] = sql
      .exec<Record<string, string | number | null>>(`SELECT * FROM "${table}" ORDER BY rowid`)
      .toArray();
  }
  return {
    format: "mise.household-export",
    version: EXPORT_FORMAT_VERSION,
    schemaVersion: schemaVersion(sql),
    tables,
    sequences: sequences(sql, householdTables(sql)),
    photoKeys,
  };
}

/** Loads an export into an empty household. Refuses a household that holds any data. */
export function restoreHousehold(storage: DurableObjectStorage, input: unknown): RestoreResult {
  const parsed = HouseholdExport.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_export", message: "Not a Mise household export" } };
  }
  const data = parsed.data;
  const { sql } = storage;

  const current = schemaVersion(sql);
  if (data.schemaVersion !== current) {
    return {
      ok: false,
      error: {
        code: "schema_mismatch",
        message: `The export is at schema version ${data.schemaVersion}; this deployment is at ${current}`,
      },
    };
  }

  const tables = householdTables(sql);
  const exported = Object.keys(data.tables).sort();
  if (exported.join() !== tables.join()) {
    return { ok: false, error: { code: "invalid_export", message: "The export's tables do not match the schema" } };
  }

  try {
    return storage.transactionSync(() => {
      const loaded = loadRows(sql, tables, data);
      if (loaded.ok) {
        restoreSequences(sql, tables, data.sequences);
        readBack(sql);
      }
      return loaded;
    });
  } catch (error) {
    // Thrown inside the transaction so that a bad row rolls the whole restore back.
    if (error instanceof InvalidExport) return { ok: false, error: { code: "invalid_export", message: error.message } };
    throw error;
  }
}

function loadRows(sql: SqlStorage, tables: string[], data: HouseholdExport): RestoreResult {
  if (tables.some((table) => sql.exec(`SELECT 1 FROM "${table}" LIMIT 1`).toArray().length > 0)) {
    return { ok: false, error: { code: "not_empty", message: "Restore only loads into an empty household" } };
  }
  // Tables load in name order, so a row can arrive before the row it references (import_error
  // before import_run); the references are checked when the transaction commits.
  sql.exec("PRAGMA defer_foreign_keys = ON");
  for (const table of tables) {
    const columns = new Set(
      sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info(?)", table)
        .toArray()
        .map((c) => c.name),
    );
    for (const row of data.tables[table] ?? []) {
      const names = Object.keys(row);
      const unknown = names.find((name) => !columns.has(name));
      if (unknown) throw new InvalidExport(`Unknown column ${table}.${unknown}`);
      sql.exec(
        `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(", ")})
           VALUES (${names.map(() => "?").join(", ")})`,
        ...Object.values(row),
      );
    }
  }
  return { ok: true };
}

/** Puts back the id counters, which the rows alone would leave at the highest surviving id. */
function restoreSequences(sql: SqlStorage, tables: string[], exported: HouseholdExport["sequences"]): void {
  // Inserting the rows has already moved each counter up to its table's highest id.
  const afterInsert = sequences(sql, tables);
  for (const [table, seq] of Object.entries(exported)) {
    if (!tables.includes(table)) throw new InvalidExport(`Id counter for unknown table ${table}`);
    const current = afterInsert[table];
    if (current === undefined) sql.exec("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)", table, seq);
    else if (seq < current) throw new InvalidExport(`The id counter for ${table} is behind its rows`);
    else sql.exec("UPDATE sqlite_sequence SET seq = ? WHERE name = ?", seq, table);
  }
}

/** The AUTOINCREMENT counters of the household tables, by table name. */
function sequences(sql: SqlStorage, tables: string[]): HouseholdExport["sequences"] {
  const rows = sql.exec<{ name: string; seq: number }>("SELECT name, seq FROM sqlite_sequence ORDER BY name").toArray();
  return Object.fromEntries(rows.filter(({ name }) => tables.includes(name)).map(({ name, seq }) => [name, seq]));
}

/** Reads the restored household through the domain parsers, so a household no tool can read is never committed. */
function readBack(sql: SqlStorage): void {
  // Foreign keys are only checked on commit (see loadRows), too late to refuse the export cleanly.
  if (sql.exec("PRAGMA foreign_key_check").toArray().length > 0) {
    throw new InvalidExport("The export holds rows that refer to rows it does not have");
  }
  try {
    parseStoredHousehold(sql);
  } catch (error) {
    if (error instanceof z.ZodError) throw new InvalidExport("The export holds data that is not valid Household data");
    throw error;
  }
}

class InvalidExport extends Error {}

function householdTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((table) => table.name)
    .filter((name) => !NOT_HOUSEHOLD_DATA.test(name) && !BOOKKEEPING.has(name));
}
