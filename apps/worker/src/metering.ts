import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Rows SQLite read and wrote. Inside a Durable Object the clock moves only when it waits on I/O, so
 * synchronous SQL always times at 0 ms however long it really takes; rows are what show its weight.
 */
export type Rows = { read: number; written: number };

type Meter = { cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] };

/** The meters of every `countRows` the code running now is inside, outermost first. */
const meters = new AsyncLocalStorage<readonly Meter[]>();
const HOOKED = Symbol.for("mise.metered");

/**
 * Makes every query on `sql` count towards the `countRows` it runs within: Mise's own, and those of
 * the Agents SDK and Pi, which share the same storage. Hooking it again does nothing.
 */
export function meterQueries(sql: SqlStorage): void {
  const hooked = sql as SqlStorage & { [HOOKED]?: true };
  if (hooked[HOOKED]) return;
  const exec = sql.exec;
  hooked.exec = function (this: SqlStorage, ...args: Parameters<SqlStorage["exec"]>) {
    const cursor = exec.apply(this, args);
    for (const meter of meters.getStore() ?? []) meter.cursors.push(cursor);
    return cursor;
  } as SqlStorage["exec"];
  hooked[HOOKED] = true;
}

/**
 * Runs `work`, then reports the rows read and written by the queries made within it, across its
 * awaits too. Within another `countRows`, its queries count towards both.
 */
export async function countRows<T>(work: () => Promise<T> | T, report: (rows: Rows) => void): Promise<T> {
  const meter: Meter = { cursors: [] };
  try {
    return await meters.run([...(meters.getStore() ?? []), meter], work);
  } finally {
    // A cursor's counts grow as it is read, so they are summed once the work is done with them.
    report({
      read: meter.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      written: meter.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
    });
  }
}

/** Rows as span attributes. */
export function rowAttributes(rows: Rows): Record<string, number> {
  return { "mise.rows_read": rows.read, "mise.rows_written": rows.written };
}

/**
 * How long a call waited between the device sending it and the Household starting it, from the
 * device's clock, in ms; undefined when the device sent no time. Devices keep network time, so the
 * skew is well under a second: enough to tell a call queued for 40 s from one sent in a burst.
 */
export function queuedMs(sentAt: unknown, now: number): number | undefined {
  return typeof sentAt === "number" && Number.isFinite(sentAt) ? Math.round(now - sentAt) : undefined;
}
