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
  {
    version: 4,
    statements: [
      // The Household's own Items, keyed 'household:<id>' (ADR 0009). AUTOINCREMENT because
      // Ingredients store the key, so a key is never handed out twice.
      `CREATE TABLE item (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        section TEXT NOT NULL,
        unit_family TEXT NOT NULL
      )`,
      `CREATE TABLE item_allergen (
        item_id INTEGER NOT NULL REFERENCES item (id),
        position INTEGER NOT NULL,
        allergen TEXT NOT NULL,
        PRIMARY KEY (item_id, position)
      )`,
      // Names the Household gave an Item, shipped or its own; item_id is the Item's key.
      `CREATE TABLE item_alias (
        id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL,
        alias TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 5,
    statements: [
      "ALTER TABLE recipe ADD COLUMN notes TEXT",
      // 'manual' or 'paprika'; an imported Recipe keeps the source's id and revision of it.
      "ALTER TABLE recipe ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'",
      "ALTER TABLE recipe ADD COLUMN source_id TEXT",
      "ALTER TABLE recipe ADD COLUMN source_revision TEXT",
      "ALTER TABLE recipe ADD COLUMN source_url TEXT",
      "ALTER TABLE recipe ADD COLUMN source_author TEXT",
      "ALTER TABLE recipe ADD COLUMN imported_at TEXT",
      "ALTER TABLE recipe ADD COLUMN imported_preference TEXT",
      "ALTER TABLE recipe ADD COLUMN edited_in_app_at TEXT",
      "CREATE UNIQUE INDEX recipe_source ON recipe (source_kind, source_id) WHERE source_id IS NOT NULL",
      `CREATE TABLE import_run (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        started_at TEXT NOT NULL,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        skipped INTEGER NOT NULL,
        flagged INTEGER NOT NULL
      )`,
      // entry is null for an error about the export as a whole.
      `CREATE TABLE import_error (
        run_id INTEGER NOT NULL REFERENCES import_run (id),
        position INTEGER NOT NULL,
        entry TEXT,
        message TEXT NOT NULL,
        PRIMARY KEY (run_id, position)
      )`,
      // source_revision is the revision a merge flag left alone, so the same one is flagged once.
      `CREATE TABLE import_flag (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES import_run (id),
        kind TEXT NOT NULL,
        recipe_id INTEGER NOT NULL REFERENCES recipe (id),
        duplicate_of INTEGER REFERENCES recipe (id),
        source_revision TEXT,
        flagged_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 6,
    statements: [
      // A Week is keyed by its start date. Slots are keyed by their own date, not by their Week, so
      // they stay on their dates whatever day the Week starts on.
      "CREATE TABLE week (start_date TEXT PRIMARY KEY)",
      // A Slot is stored once someone edits it; until then it is unplanned, for the default Diners.
      // diners_chosen is 0 while the Diners follow the Household's default, 1 once slot_diner lists them.
      `CREATE TABLE slot (
        date TEXT NOT NULL,
        meal TEXT NOT NULL,
        kind TEXT NOT NULL,
        recipe_id INTEGER REFERENCES recipe (id),
        note TEXT,
        diners_chosen INTEGER NOT NULL,
        guests INTEGER NOT NULL,
        locked INTEGER NOT NULL,
        PRIMARY KEY (date, meal)
      )`,
      "CREATE INDEX slot_recipe ON slot (recipe_id)",
      `CREATE TABLE slot_diner (
        date TEXT NOT NULL,
        meal TEXT NOT NULL,
        member_id INTEGER NOT NULL REFERENCES member (id),
        PRIMARY KEY (date, meal, member_id),
        FOREIGN KEY (date, meal) REFERENCES slot (date, meal)
      )`,
      `CREATE TABLE slot_guest_constraint (
        date TEXT NOT NULL,
        meal TEXT NOT NULL,
        position INTEGER NOT NULL,
        kind TEXT NOT NULL,
        allergen TEXT,
        term TEXT,
        PRIMARY KEY (date, meal, position),
        FOREIGN KEY (date, meal) REFERENCES slot (date, meal)
      )`,
    ],
  },
  {
    version: 7,
    statements: [
      // A Slot planned despite a Conflict: member_id is the Diner it is for, or NULL for the Guests. It
      // holds only while the Conflict has the same cause: a reason given for unknown Allergens says
      // nothing once the Recipe is known to contain one.
      `CREATE TABLE slot_override (
        date TEXT NOT NULL,
        meal TEXT NOT NULL,
        position INTEGER NOT NULL,
        member_id INTEGER REFERENCES member (id),
        allergen TEXT NOT NULL,
        cause TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (date, meal, position),
        FOREIGN KEY (date, meal) REFERENCES slot (date, meal)
      )`,
    ],
  },
  {
    version: 8,
    statements: [
      // The Household's own Effort Budgets; a weekday without a row has the default one.
      "CREATE TABLE effort_budget (weekday TEXT PRIMARY KEY, minutes INTEGER NOT NULL)",
      // The seed and choice ('best' or 'any') the Week was last proposed with, null until it is;
      // reviewed is 1 once someone has looked it over since.
      "ALTER TABLE week ADD COLUMN proposal_seed INTEGER",
      "ALTER TABLE week ADD COLUMN proposal_choice TEXT",
      "ALTER TABLE week ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0",
      `CREATE TABLE week_effort_budget (
        start_date TEXT NOT NULL REFERENCES week (start_date),
        weekday TEXT NOT NULL,
        minutes INTEGER NOT NULL,
        PRIMARY KEY (start_date, weekday)
      )`,
      // Why the latest Proposal left a Slot as it did, as JSON; dropped once the Slot is set by hand.
      `CREATE TABLE slot_reason (
        date TEXT NOT NULL,
        meal TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (date, meal),
        FOREIGN KEY (date, meal) REFERENCES slot (date, meal)
      )`,
    ],
  },
  {
    version: 9,
    statements: [
      // When a Slot was marked cooked, null until it is; it counts for its Recipe on the Slot's date.
      "ALTER TABLE slot ADD COLUMN cooked_at TEXT",
      // A Rating of a cooked Slot: member_id is the Member who gave it, NULL when none did. One per
      // Member and Slot; those without a Member are each kept.
      `CREATE TABLE slot_rating (
        id INTEGER PRIMARY KEY,
        date TEXT NOT NULL,
        meal TEXT NOT NULL,
        member_id INTEGER REFERENCES member (id),
        rating TEXT NOT NULL,
        note TEXT,
        rated_at TEXT NOT NULL,
        FOREIGN KEY (date, meal) REFERENCES slot (date, meal)
      )`,
      "CREATE UNIQUE INDEX slot_rating_member ON slot_rating (date, meal, member_id) WHERE member_id IS NOT NULL",
    ],
  },
  {
    version: 10,
    statements: [
      // The Store Sections the Household put in walking order; the rest follow in their usual order.
      "CREATE TABLE store_section (position INTEGER PRIMARY KEY, section TEXT NOT NULL UNIQUE)",
      // When the Week's Grocery List was last built, null until it is, and the plan revision it was
      // built from (ADR 0015).
      "ALTER TABLE week ADD COLUMN grocery_built_at TEXT",
      "ALTER TABLE week ADD COLUMN grocery_plan_revision TEXT",
      // A line of a Week's Grocery List. origin is 'recipe' or 'manual'. A 'recipe' line has an Item,
      // or the Unresolved Ingredient as written in text; a 'manual' one has its text as typed and the
      // Item it names, if any. amounts and recipe_ids are JSON. have_at is when the Have Tick was last
      // set, either way.
      `CREATE TABLE grocery_line (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_date TEXT NOT NULL REFERENCES week (start_date),
        origin TEXT NOT NULL,
        item_id TEXT,
        text TEXT,
        amounts TEXT NOT NULL,
        unmeasured INTEGER NOT NULL,
        recipe_ids TEXT NOT NULL,
        have INTEGER NOT NULL,
        have_at TEXT
      )`,
      "CREATE INDEX grocery_line_week ON grocery_line (start_date)",
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
