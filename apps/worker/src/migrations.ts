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
  {
    version: 3,
    statements: [
      `CREATE TABLE recipe (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        base_servings INTEGER NOT NULL,
        effort_minutes INTEGER,
        cuisine TEXT,
        main_protein TEXT,
        -- 'weekly', or the weekday it comes back on
        recurring TEXT,
        yields_leftovers INTEGER NOT NULL,
        prep_ahead TEXT,
        photo_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // The line as written and as parsed; item_id is null for an Unresolved Ingredient.
      `CREATE TABLE recipe_ingredient (
        recipe_id INTEGER NOT NULL REFERENCES recipe (id),
        position INTEGER NOT NULL,
        raw TEXT NOT NULL,
        amount_min REAL,
        amount_max REAL,
        unit TEXT,
        name TEXT NOT NULL,
        note TEXT,
        item_id TEXT,
        PRIMARY KEY (recipe_id, position)
      )`,
      "CREATE INDEX recipe_ingredient_item ON recipe_ingredient (item_id)",
      `CREATE TABLE recipe_step (
        recipe_id INTEGER NOT NULL REFERENCES recipe (id),
        position INTEGER NOT NULL,
        text TEXT NOT NULL,
        PRIMARY KEY (recipe_id, position)
      )`,
      `CREATE TABLE recipe_tag (
        recipe_id INTEGER NOT NULL REFERENCES recipe (id),
        position INTEGER NOT NULL,
        tag TEXT NOT NULL,
        PRIMARY KEY (recipe_id, position)
      )`,
      "CREATE INDEX recipe_tag_tag ON recipe_tag (tag)",
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
