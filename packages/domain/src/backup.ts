import { z } from "zod";

/** Bumped when the shape of the export file changes, independently of the database schema. */
export const EXPORT_FORMAT_VERSION = 2;

/** The Household-local wall-clock time the nightly export runs at. */
export const NIGHTLY_EXPORT_TIME = "03:00";

/** One SQLite value; blobs are not stored in the household database. */
const SqlValue = z.union([z.string(), z.number(), z.null()]);

/**
 * Everything needed to rebuild a Household in a fresh deployment. Deterministic: the same data
 * always serialises to the same file, so it carries no timestamp (the R2 key names the date).
 */
export const HouseholdExport = z
  .object({
    format: z.literal("mise.household-export"),
    version: z.literal(EXPORT_FORMAT_VERSION),
    /** The database schema version the rows belong to. */
    schemaVersion: z.number().int().positive(),
    /** Every domain table, by name, with its rows in insertion order. */
    tables: z.record(z.string(), z.array(z.record(z.string(), SqlValue))),
    /** The last id each AUTOINCREMENT table handed out, so a removed row's id is never reused. */
    sequences: z.record(z.string(), z.number().int().nonnegative()),
    /** Keys of the R2 objects (recipe photos) the data refers to. The objects stay in R2. */
    photoKeys: z.array(z.string()),
  })
  .strict();
export type HouseholdExport = z.infer<typeof HouseholdExport>;

/** The R2 prefix nightly Backups are stored under. */
export const BACKUP_PREFIX = "exports/";

/** Where the nightly Backup taken on a Household-local date lives in R2. */
export function exportKey(localDate: string): string {
  return `${BACKUP_PREFIX}${localDate}.json`;
}

/** How many of the newest nightly Backups are kept, whatever their dates. */
export const KEPT_NIGHTLY_BACKUPS = 30;

/**
 * The nightly Backups to delete from these R2 keys: all but the newest `KEPT_NIGHTLY_BACKUPS` and
 * the earliest of each month (ADR 0006). Counted, not dated, so if the nightly Backup stops, nothing
 * is deleted.
 */
export function backupsToPrune(keys: string[]): string[] {
  // Only nightly Backups; a file put under exports/ by hand stays.
  const newestFirst = keys
    .filter((key) => key.startsWith(BACKUP_PREFIX) && /^\d{4}-\d{2}-\d{2}\.json$/.test(key.slice(BACKUP_PREFIX.length)))
    .sort()
    .reverse();
  const earliestOfMonth = new Map<string, string>();
  for (const key of newestFirst) earliestOfMonth.set(key.slice(0, BACKUP_PREFIX.length + "YYYY-MM".length), key);
  const kept = new Set([...newestFirst.slice(0, KEPT_NIGHTLY_BACKUPS), ...earliestOfMonth.values()]);
  return newestFirst.filter((key) => !kept.has(key)).reverse();
}

/** The R2 prefix recipe photos are stored under. */
export const PHOTO_PREFIX = "photos/";
