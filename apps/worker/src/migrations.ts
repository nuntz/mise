/**
 * Schema migrations for the household Durable Object, applied in order at startup.
 * Append new versions; never edit a released one. Table names never start with `pi_`,
 * which is reserved for the Pi harness.
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
];

export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const current =
      storage.sql.exec<{ version: number }>("SELECT max(version) AS version FROM schema_version").one().version ?? 0;
    for (const migration of migrations) {
      if (migration.version <= current) continue;
      for (const statement of migration.statements) storage.sql.exec(statement);
      storage.sql.exec("INSERT INTO schema_version (version) VALUES (?)", migration.version);
    }
  });
}
