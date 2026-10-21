import { z } from "zod";

/** Bumped when the shape of the export file changes, independently of the database schema. */
export const EXPORT_FORMAT_VERSION = 1;

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
    /** Keys of the R2 objects (recipe photos) the data refers to. The objects stay in R2. */
    photoKeys: z.array(z.string()),
  })
  .strict();
export type HouseholdExport = z.infer<typeof HouseholdExport>;

/** Where a nightly export taken on a Household-local date lives in R2. */
export function exportKey(localDate: string): string {
  return `exports/${localDate}.json`;
}

/** The R2 prefix recipe photos are stored under. */
export const PHOTO_PREFIX = "photos/";
