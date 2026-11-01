import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { countRows, meterQueries, queuedMs, type Rows } from "../src/metering";

describe("row metering", () => {
  test("counts the rows each piece of work read and wrote, across awaits and nested work", async () => {
    await runInDurableObject(env.Household.getByName(crypto.randomUUID()), async (_household, state) => {
      const { sql } = state.storage;
      meterQueries(sql);
      meterQueries(state.storage.sql);
      sql.exec("CREATE TABLE metered (n INTEGER)");
      for (let n = 0; n < 10; n++) sql.exec("INSERT INTO metered VALUES (?)", n);

      let outer: Rows | undefined;
      let inner: Rows | undefined;
      await countRows(
        async () => {
          state.storage.sql.exec("SELECT n FROM metered").toArray();
          await scheduler.wait(1);
          await countRows(
            () => {
              state.storage.sql.exec("INSERT INTO metered VALUES (10), (11)");
            },
            (rows) => {
              inner = rows;
            },
          );
        },
        (rows) => {
          outer = rows;
        },
      );

      expect(inner).toEqual({ read: 0, written: 2 });
      // The scan reads every row; the nested insert counts towards the outer work too.
      expect(outer).toEqual({ read: 10, written: 2 });
    });
  });

  test("counts nothing outside metered work, and reports even when the work throws", async () => {
    await runInDurableObject(env.Household.getByName(crypto.randomUUID()), async (_household, state) => {
      meterQueries(state.storage.sql);
      state.storage.sql.exec("CREATE TABLE metered (n INTEGER)");
      let reported: Rows | undefined;
      const failing = countRows(
        () => {
          state.storage.sql.exec("INSERT INTO metered VALUES (1)");
          throw new Error("refused");
        },
        (rows) => {
          reported = rows;
        },
      );
      await expect(failing).rejects.toThrow("refused");
      expect(reported).toEqual({ read: 0, written: 1 });
    });
  });
});

describe("queue time", () => {
  test("is the time since the device sent the call, when it said", () => {
    expect(queuedMs(1_000, 46_600.4)).toBe(45_600);
    expect(queuedMs(undefined, 1_000)).toBeUndefined();
    expect(queuedMs("1000", 1_000)).toBeUndefined();
    expect(queuedMs(Number.NaN, 1_000)).toBeUndefined();
  });
});
