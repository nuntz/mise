import { describe, expect, test } from "bun:test";
import namespaces from "../fixtures/cloudflare/namespaces.json";
import unauthorized from "../fixtures/cloudflare/unauthorized.json";
import recorded from "../fixtures/cloudflare/usage.json";
import { formatUsage, HOURLY_LIMIT, householdNamespace, readUsage, usageQuery, windowOf } from "./usage";

const NOW = new Date("2026-11-21T15:30:00Z");
const [ACCOUNT] = recorded.data.viewer.accounts;
if (!ACCOUNT) throw new Error("The recorded answer holds no account.");
/** An answer with no groups in any dataset, as for a window with no traffic. */
const QUIET = {
  data: {
    viewer: {
      accounts: [
        {
          ...{ workerAll: [], workerStatus: [], workerHours: [], doStatus: [], doDays: [] },
          ...{ doPeriodic: [], doSql: [], r2Ops: [], r2Gets: [], r2Storage: [] },
        },
      ],
    },
  },
  errors: null,
};

describe("windowOf", () => {
  test("is the 7 days before now by default", () => {
    expect(windowOf({}, NOW)).toEqual({
      start: new Date("2026-11-14T15:30:00Z"),
      end: NOW,
      days: 7,
    });
  });

  test("ends at --until, a date alone being its UTC midnight", () => {
    expect(windowOf({ days: "2", until: "2026-11-20" }, NOW)).toEqual({
      start: new Date("2026-11-18T00:00:00Z"),
      end: new Date("2026-11-20T00:00:00Z"),
      days: 2,
    });
  });

  test("refuses what Cloudflare would: over 31 days, or reaching back past 90", () => {
    expect(() => windowOf({ days: "32" }, NOW)).toThrow("--days takes a whole number from 1 to 31.");
    expect(() => windowOf({ days: "1.5" }, NOW)).toThrow("--days");
    expect(() => windowOf({ days: "0" }, NOW)).toThrow("--days");
    expect(() => windowOf({ until: "2026-08-25" }, NOW)).toThrow("Cloudflare keeps 90 days");
    expect(() => windowOf({ until: "soon" }, NOW)).toThrow("--until takes an ISO 8601 date or time");
    expect(() => windowOf({ until: "2026-11-22" }, NOW)).toThrow("--until can't be later than now");
  });
});

describe("householdNamespace", () => {
  test("is the id of the namespace this deployment's Worker holds its Household class in", () => {
    expect(householdNamespace(namespaces, { script: "mise", className: "Household" })).toEqual({
      id: "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b",
      name: "mise_Household",
    });
  });

  test("says when it may be on a page the list didn't answer", () => {
    const firstPage = { ...namespaces, result: namespaces.result.slice(0, 1) };
    expect(() => householdNamespace(firstPage, { script: "mise", className: "Household" })).toThrow(
      "The namespace list ran past its first page (1 of 3).",
    );
  });

  test("refuses when there is none, naming no other namespace on the account", () => {
    const missing = () => householdNamespace(namespaces, { script: "renamed", className: "Household" });
    expect(missing).toThrow("No Durable Object namespace holds renamed's Household");
    expect(missing).not.toThrow("other");
  });

  test("refuses an answer that failed", () => {
    const failed = { success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null };
    expect(() => householdNamespace(failed, { script: "mise", className: "Household" })).toThrow(
      "Cloudflare refused the namespace list: Authentication error",
    );
  });
});

const OWN = { script: "mise", bucket: "mise", namespaceId: "1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b" };
/** The recorded answer's window: half of 11-13, then all of 11-14. */
const WINDOW = { start: new Date("2026-11-13T12:00:00Z"), end: new Date("2026-11-15T00:00:00Z"), days: 1.5 };

describe("usageQuery", () => {
  const { query, variables } = usageQuery(OWN, WINDOW, "account-tag");
  /** Each dataset the query asks for: its alias, and the text of its filter. */
  const datasets = [...query.matchAll(/(\w+): \w+\(limit: \d+, filter: \{([^}]*)\}/g)].map(([, alias, filter]) => ({
    alias,
    filter,
  }));

  test("filters every dataset to this deployment's Worker, namespace or bucket", () => {
    expect(datasets.length).toBe(Object.keys(ACCOUNT).length);
    for (const { alias, filter } of datasets) {
      expect({
        alias,
        own: /scriptName: \$script|namespaceId: \$namespace|bucketName: \$bucket/.test(filter ?? ""),
      }).toEqual({
        alias,
        own: true,
      });
    }
    expect(variables).toMatchObject({
      account: "account-tag",
      script: "mise",
      bucket: "mise",
      namespace: OWN.namespaceId,
    });
  });

  test("asks for the datasets the recorded answer holds", () => {
    expect(datasets.map((d) => d.alias).sort()).toEqual(Object.keys(ACCOUNT).sort());
  });

  test("covers the window, its daily samples by the UTC days it touches", () => {
    expect(variables).toMatchObject({
      start: "2026-11-13T12:00:00.000Z",
      end: "2026-11-15T00:00:00.000Z",
      firstDay: "2026-11-13",
      lastDay: "2026-11-14",
    });
  });
});

describe("readUsage", () => {
  const usage = readUsage(recorded, WINDOW);

  test("totals the Worker's requests by status, with their CPU and wall times", () => {
    expect(usage.worker.requests).toBe(120);
    expect(usage.worker.times).toEqual({ cpuP50: 5000, cpuP99: 40000, wallP50: 400000, wallP99: 300000000 });
    expect(usage.worker.byStatus.map((s) => [s.status, s.requests, s.times.cpuP50])).toEqual([
      ["success", 110, 5100],
      ["clientDisconnected", 8, 4500],
      ["responseStreamDisconnected", 2, 28000],
    ]);
  });

  test("sets the Worker's busiest hour against the rest of the window", () => {
    expect(usage.worker.busiestHour).toEqual({
      hour: "2026-11-14T09:00:00Z",
      requests: 76,
      byStatus: [
        ["success", 70],
        ["clientDisconnected", 6],
      ],
    });
    expect(usage.worker.rest).toEqual({
      hours: 35,
      requests: 44,
      byStatus: [
        ["success", 40],
        ["clientDisconnected", 2],
        ["responseStreamDisconnected", 2],
      ],
    });
  });

  test("counts the rest by every hourly bucket the window reaches into, partial ones included", () => {
    const offHour = { start: new Date("2026-11-13T12:30:00Z"), end: new Date("2026-11-15T00:30:00Z"), days: 1.5 };
    expect(readUsage(recorded, offHour).worker.rest.hours).toBe(36);
  });

  test("totals the Durable Object's requests, rows, WebSocket messages and active time", () => {
    expect(usage.durableObject).toEqual({
      requests: 305,
      byStatus: [
        ["success", 300],
        ["clientDisconnected", 5],
      ],
      rowsRead: 2_900_000,
      rowsWritten: 1000,
      websocketIn: 15,
      websocketOut: 50,
      activeSeconds: 60,
    });
  });

  test("counts R2 operations by type, its busiest hour for GetObject, and storage at each end", () => {
    expect(usage.r2).toEqual({
      operations: 72,
      byType: [
        ["GetObject", 60],
        ["HeadBucket", 6],
        ["PutObject", 4],
        ["ListObjects", 2],
      ],
      busiestGetHour: { hour: "2026-11-14T09:00:00Z", requests: 45 },
      storage: {
        first: { date: "2026-11-13", objects: 377, bytes: 148_009_900 },
        last: { date: "2026-11-14", objects: 380, bytes: 150_010_000 },
      },
    });
  });

  test("lists each UTC day the window touches, marking the ones it only partly covers", () => {
    expect(usage.days).toEqual([
      {
        date: "2026-11-13",
        partial: true,
        workerRequests: 10,
        doRequests: 45,
        rowsRead: 400_000,
        rowsWritten: 100,
        sqliteBytes: 6_850_000,
        r2Gets: 5,
      },
      {
        date: "2026-11-14",
        partial: false,
        workerRequests: 110,
        doRequests: 260,
        rowsRead: 2_500_000,
        rowsWritten: 900,
        sqliteBytes: 6_900_000,
        r2Gets: 55,
      },
    ]);
  });

  test("gives a quiet window no busiest hour and empty days, not a failure", () => {
    const read = readUsage(QUIET, WINDOW);
    expect(read.worker.requests).toBe(0);
    expect(read.worker.busiestHour).toBeNull();
    expect(read.r2.storage).toEqual({ first: null, last: null });
    expect(read.days.map((d) => [d.date, d.workerRequests, d.sqliteBytes])).toEqual([
      ["2026-11-13", 0, null],
      ["2026-11-14", 0, null],
    ]);
  });

  test("refuses an answer Cloudflare didn't authorize, naming the permission it needs", () => {
    expect(() => readUsage(unauthorized, WINDOW)).toThrow("not authorized for that account");
    expect(() => readUsage(unauthorized, WINDOW)).toThrow("Account Analytics: Read");
  });

  test("refuses an hourly answer cut short at its page size", () => {
    const hour = { dimensions: { datetimeHour: "2026-11-14T09:00:00Z" }, sum: { requests: 1 } };
    const r2Gets = Array.from({ length: HOURLY_LIMIT }, () => hour);
    const full = { ...recorded, data: { viewer: { accounts: [{ ...ACCOUNT, r2Gets }] } } };
    expect(() => readUsage(full, WINDOW)).toThrow("r2Gets");
  });
});

describe("formatUsage", () => {
  const names = { script: "mise", namespace: "mise_Household", bucket: "mise" };

  test("prints the Worker, the Durable Object namespace and the bucket, then each UTC day", () => {
    expect(formatUsage(readUsage(recorded, WINDOW), names).split("\n")).toEqual([
      "Cloudflare usage: 2026-11-13 12:00Z to 2026-11-15 00:00Z (1.5 days)",
      "",
      "Worker mise",
      "  120 requests: success 110 · clientDisconnected 8 · responseStreamDisconnected 2",
      "  CPU p50 5.0 ms, p99 40.0 ms · wall p50 400.0 ms, p99 5.0 min",
      "    success 110: CPU p50 5.1 ms, p99 39.0 ms · wall p50 380.0 ms, p99 2.0 s",
      "    clientDisconnected 8: CPU p50 4.5 ms, p99 36.0 ms · wall p50 420.0 ms, p99 6.2 min",
      "    responseStreamDisconnected 2: CPU p50 28.0 ms, p99 55.0 ms · wall p50 4.5 min, p99 30.0 min",
      "  busiest hour 2026-11-14 09:00Z: 76 requests (success 70 · clientDisconnected 6)",
      "  the other 35 hours: 44 requests, 1.3 an hour (success 40 · clientDisconnected 2 · responseStreamDisconnected 2)",
      "",
      "Durable Object namespace mise_Household",
      "  305 requests: success 300 · clientDisconnected 5",
      "  rows read 2,900,000 · written 1,000",
      "  WebSocket messages in 15 · out 50 · active 60 s",
      "",
      "R2 bucket mise",
      "  72 operations: GetObject 60 · HeadBucket 6 · PutObject 4 · ListObjects 2",
      "  GetObject busiest hour 2026-11-14 09:00Z: 45",
      "  stored on 2026-11-14: 380 objects, 150.01 MB (on 2026-11-13: 377 objects, 148.01 MB)",
      "",
      "UTC day      Worker  DO requests  rows read  rows written   SQLite  R2 GetObject",
      "2026-11-13*      10           45    400,000           100  6.85 MB             5",
      "2026-11-14      110          260  2,500,000           900  6.90 MB            55",
      "* partly in the window",
    ]);
  });

  test("says so when the window had no traffic and no storage sample", () => {
    const lines = formatUsage(readUsage(QUIET, { ...WINDOW, start: new Date("2026-11-14T00:00:00Z"), days: 1 }), names);
    expect(lines.split("\n")).toEqual([
      "Cloudflare usage: 2026-11-14 00:00Z to 2026-11-15 00:00Z (1 day)",
      "",
      "Worker mise",
      "  0 requests",
      "",
      "Durable Object namespace mise_Household",
      "  0 requests",
      "  rows read 0 · written 0",
      "  WebSocket messages in 0 · out 0 · active 0 s",
      "",
      "R2 bucket mise",
      "  0 operations",
      "  stored: no sample in the window",
      "",
      "UTC day     Worker  DO requests  rows read  rows written  SQLite  R2 GetObject",
      "2026-11-14       0            0          0             0       –             0",
    ]);
  });
});
