/**
 * Schema migrations for the household Durable Object, applied in order at startup.
 * Append new versions; never edit a released one. Table names never start with `pi_` (the Pi
 * harness) or `cf_` (the Agents SDK): the export skips those prefixes (ADR 0006).
 */
const migrations: { version: number; statements: string[] }[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE household (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        dinner_time TEXT NOT NULL,
        week_starts_on TEXT NOT NULL,
        units TEXT NOT NULL,
        locale TEXT NOT NULL
      )`,
      `CREATE TABLE revision (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      )`,
      "INSERT INTO revision (id, value) VALUES (1, 0)",
    ],
  },
  {
    version: 2,
    statements: [
      // AUTOINCREMENT so a removed Member's id is never handed to someone else.
      `CREATE TABLE member (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE
      )`,
      `CREATE TABLE member_constraint (
        member_id INTEGER NOT NULL REFERENCES member (id),
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        allergen TEXT,
        term TEXT,
        PRIMARY KEY (member_id, position)
      )`,
    ],
  },
];

export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const current = schemaVersion(storage.sql);
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec("INSERT INTO schema_version (version) VALUES (?)", migration.version);
    }
  });
}

/** The schema version the database is at; 0 before the first migration. */
export function schemaVersion(sql: SqlStorage): number {
  return sql.exec<{ version: number | null }>("SELECT max(version) AS version FROM schema_version").one().version ?? 0;
}
