import { EXPORT_FORMAT_VERSION, HouseholdExport } from "@mise/domain";
import { schemaVersion } from "./migrations";

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
    return storage.transactionSync(() => loadRows(sql, tables, data));
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

class InvalidExport extends Error {}

function householdTables(sql: SqlStorage): string[] {
  return sql
    .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .toArray()
    .map((table) => table.name)
    .filter((name) => !NOT_HOUSEHOLD_DATA.test(name) && !BOOKKEEPING.has(name));
}
