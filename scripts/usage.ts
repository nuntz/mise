/**
 * This deployment's Cloudflare usage, for the weekly Prod Review. Read-only.
 *
 *   bun run usage [--days N] [--until <ISO>]    (default: the 7 days before now)
 *
 * Prints, for the window:
 *   - the Worker's requests by status, CPU and wall time p50/p99, its busiest hour against the rest,
 *     and the UTC hours in which it threw exceptions
 *   - the Household Durable Object namespace's requests by status, the UTC hours in which it threw
 *     exceptions, rows read and written, WebSocket messages and active time
 *   - the R2 bucket's operations by type, its busiest hour for GetObject, and what it stores
 *   - each UTC day: Worker and Durable Object requests, rows read and written, SQLite storage and
 *     R2 GetObject, marking a day the window only partly covers
 *
 * The account may hold other Workers, so every query is filtered to this deployment's own Worker,
 * namespace and bucket, named in apps/worker/wrangler.jsonc, and the output names nothing else on
 * the account. The namespace is looked up by its Worker and class, not kept here.
 *
 * Needs `CLOUDFLARE_API_TOKEN` (with Account · Account Analytics: Read) and `CF_ACCOUNT_ID`, from the
 * environment or `~/.config/mise/deploy.env`. Exits 0 once it has printed, 2 when it can't ask.
 */
import { parseArgs } from "node:util";
import wrangler from "../apps/worker/wrangler.jsonc";
import { deploymentValue } from "./deployEnv";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Cloudflare answers at most 32 days in one query, and nothing older than 90 days. */
const MAX_DAYS = 31;
const KEPT_DAYS = 90;

/** The UTC stretch measured: `days` days, ending (before) `end`. */
export type Window = { start: Date; end: Date; days: number };

/** The window `--days` and `--until` name, or a thrown Error that says why it can't be measured. */
export function windowOf(flags: { days?: string; until?: string }, now: Date): Window {
  const days = Number(flags.days ?? "7");
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error(`--days takes a whole number from 1 to ${MAX_DAYS}.`);
  }
  const end = flags.until === undefined ? now : new Date(flags.until);
  if (Number.isNaN(end.getTime())) throw new Error("--until takes an ISO 8601 date or time.");
  if (end > now) throw new Error("--until can't be later than now.");
  const start = new Date(end.getTime() - days * DAY_MS);
  if (now.getTime() - start.getTime() > KEPT_DAYS * DAY_MS) {
    throw new Error(`Cloudflare keeps ${KEPT_DAYS} days of analytics; this window starts before them.`);
  }
  return { start, end, days };
}

/** What `GET /accounts/:id/workers/durable_objects/namespaces` answers, as far as this reads it. */
export type NamespaceList = {
  success: boolean;
  errors?: { message: string }[];
  result: { id: string; name: string; script: string | null; class: string | null }[] | null;
  result_info?: { total_count: number };
};

/** The namespace in which `script` keeps its `className` Durable Objects, or a thrown Error. */
export function householdNamespace(
  answer: NamespaceList,
  own: { script: string; className: string },
): { id: string; name: string } {
  if (!answer.success || !answer.result) {
    const why = answer.errors?.map((e) => e.message).join("; ") || "no reason given";
    throw new Error(`Cloudflare refused the namespace list: ${why}`);
  }
  const found = answer.result.find((n) => n.script === own.script && n.class === own.className);
  if (found) return { id: found.id, name: found.name };
  const listed = answer.result.length;
  const total = answer.result_info?.total_count ?? listed;
  if (total > listed) throw new Error(`The namespace list ran past its first page (${listed} of ${total}).`);
  throw new Error(`No Durable Object namespace holds ${own.script}'s ${own.className} objects.`);
}

/** The names that are this deployment's own on a Cloudflare account that may hold others. */
export type Own = { script: string; bucket: string; namespaceId: string };

/** Groups a dataset may answer by the hour; a full page means the answer was cut short. */
export const HOURLY_LIMIT = 10_000;

/**
 * One GraphQL Analytics query for the window, every dataset filtered to `own`'s Worker, Durable
 * Object namespace or R2 bucket. Times are in microseconds; daily samples (`doSql`, `r2Storage`)
 * cover each UTC day the window touches.
 */
export function usageQuery(own: Own, window: Window, accountTag: string): { query: string; variables: object } {
  const during = "datetime_geq: $start, datetime_lt: $end";
  const worker = `scriptName: $script, ${during}`;
  const durable = `namespaceId: $namespace, ${during}`;
  const bucket = `bucketName: $bucket, ${during}`;
  const times = "quantiles { cpuTimeP50 cpuTimeP99 wallTimeP50 wallTimeP99 }";
  const query = `query($account: String!, $script: string!, $namespace: string!, $bucket: string!, $start: Time!, $end: Time!, $firstDay: Date!, $lastDay: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workerAll: workersInvocationsAdaptive(limit: 1, filter: {${worker}}) { sum { requests } ${times} }
    workerStatus: workersInvocationsAdaptive(limit: 100, filter: {${worker}}) { sum { requests } ${times} dimensions { status } }
    workerHours: workersInvocationsAdaptive(limit: ${HOURLY_LIMIT}, filter: {${worker}}) { sum { requests } dimensions { datetimeHour status } }
    doStatus: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {${durable}}) { sum { requests } dimensions { status } }
    doDays: durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {${durable}}) { sum { requests } dimensions { date } }
    doHours: durableObjectsInvocationsAdaptiveGroups(limit: ${HOURLY_LIMIT}, filter: {${durable}}) { sum { requests } dimensions { datetimeHour status } }
    doPeriodic: durableObjectsPeriodicGroups(limit: 100, filter: {${durable}}) { sum { rowsRead rowsWritten inboundWebsocketMsgCount outboundWebsocketMsgCount activeTime } dimensions { date } }
    doSql: durableObjectsSqlStorageGroups(limit: 100, filter: {namespaceId: $namespace, date_geq: $firstDay, date_leq: $lastDay}) { max { storedBytes } dimensions { date } }
    r2Ops: r2OperationsAdaptiveGroups(limit: 100, filter: {${bucket}}) { sum { requests } dimensions { actionType } }
    r2Gets: r2OperationsAdaptiveGroups(limit: ${HOURLY_LIMIT}, filter: {${bucket}, actionType: "GetObject"}) { sum { requests } dimensions { datetimeHour } }
    r2Storage: r2StorageAdaptiveGroups(limit: 100, filter: {${bucket}}) { max { payloadSize metadataSize objectCount } dimensions { date } }
  } }
}`;
  return {
    query,
    variables: {
      account: accountTag,
      script: own.script,
      namespace: own.namespaceId,
      bucket: own.bucket,
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      firstDay: utcDate(window.start),
      // The last UTC day the window reaches into: one that starts as the window ends isn't in it.
      lastDay: utcDate(new Date(window.end.getTime() - 1)),
    },
  };
}

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

type Quantiles = { cpuTimeP50: number; cpuTimeP99: number; wallTimeP50: number; wallTimeP99: number };
type Requests = { sum: { requests: number } };
/** A dataset's requests in one UTC hour with one status. */
type HourlyStatus = Requests & { dimensions: { datetimeHour: string; status: string } };
/** What GraphQL Analytics answers to `usageQuery`, one field per dataset. */
export type Answer = {
  data: {
    viewer: {
      accounts: {
        workerAll: (Requests & { quantiles: Quantiles })[];
        workerStatus: (Requests & { quantiles: Quantiles; dimensions: { status: string } })[];
        workerHours: HourlyStatus[];
        doStatus: (Requests & { dimensions: { status: string } })[];
        doDays: (Requests & { dimensions: { date: string } })[];
        doHours: HourlyStatus[];
        doPeriodic: {
          dimensions: { date: string };
          sum: {
            rowsRead: number;
            rowsWritten: number;
            inboundWebsocketMsgCount: number;
            outboundWebsocketMsgCount: number;
            activeTime: number;
          };
        }[];
        doSql: { dimensions: { date: string }; max: { storedBytes: number } }[];
        r2Ops: (Requests & { dimensions: { actionType: string } })[];
        r2Gets: (Requests & { dimensions: { datetimeHour: string } })[];
        r2Storage: {
          dimensions: { date: string };
          max: { payloadSize: number; metadataSize: number; objectCount: number };
        }[];
      }[];
    };
  } | null;
  errors: { message: string; extensions?: { code?: string } }[] | null;
};

/** CPU and wall time quantiles, in microseconds. */
export type Times = { cpuP50: number; cpuP99: number; wallP50: number; wallP99: number };
/** Counts by name, largest first. */
export type Counts = [string, number][];
type Storage = { date: string; objects: number; bytes: number };
/** The UTC hours in which a script threw an exception, each with how many times, oldest first. */
export type Exceptions = { hour: string; count: number }[];

/** This deployment's Cloudflare usage over a window. */
export type Usage = {
  window: Window;
  worker: {
    requests: number;
    times: Times;
    byStatus: { status: string; requests: number; times: Times }[];
    busiestHour: { hour: string; requests: number; byStatus: Counts } | null;
    rest: { hours: number; requests: number; byStatus: Counts };
    exceptions: Exceptions;
  };
  durableObject: {
    requests: number;
    byStatus: Counts;
    rowsRead: number;
    rowsWritten: number;
    websocketIn: number;
    websocketOut: number;
    activeSeconds: number;
    exceptions: Exceptions;
  };
  r2: {
    operations: number;
    byType: Counts;
    busiestGetHour: { hour: string; requests: number } | null;
    storage: { first: Storage | null; last: Storage | null };
  };
  /** Each UTC day the window touches, oldest first; `partial` when the window covers only some of it. */
  days: {
    date: string;
    partial: boolean;
    workerRequests: number;
    doRequests: number;
    rowsRead: number;
    rowsWritten: number;
    /** The day's largest sample of the namespace's SQLite storage; null when there was none. */
    sqliteBytes: number | null;
    r2Gets: number;
  }[];
};

/** `answer` read as Usage over `window`, or a thrown Error when Cloudflare refused or cut it short. */
export function readUsage(answer: Answer, window: Window): Usage {
  if (answer.errors?.length) {
    const authz = answer.errors.some((e) => e.extensions?.code === "authz");
    const why = answer.errors.map((e) => e.message).join("; ");
    throw new Error(
      `Cloudflare's GraphQL Analytics refused: ${why}${authz ? ". The API token needs Account · Account Analytics: Read." : ""}`,
    );
  }
  const account = answer.data?.viewer.accounts[0];
  if (!account) throw new Error("Cloudflare's GraphQL Analytics answered no account.");
  for (const key of ["workerHours", "doHours", "r2Gets"] as const) {
    if (account[key].length >= HOURLY_LIMIT)
      throw new Error(`${key} filled its page of ${HOURLY_LIMIT}: shorten --days.`);
  }

  const hours = new Map<string, Map<string, number>>();
  for (const g of account.workerHours) {
    const byStatus = hours.get(g.dimensions.datetimeHour) ?? new Map<string, number>();
    add(byStatus, g.dimensions.status, g.sum.requests);
    hours.set(g.dimensions.datetimeHour, byStatus);
  }
  const busiest = [...hours].map(([hour, byStatus]) => ({ hour, requests: total(byStatus), byStatus }));
  busiest.sort((a, b) => b.requests - a.requests || a.hour.localeCompare(b.hour));
  const top = busiest[0];
  const rest = new Map<string, number>();
  for (const { byStatus } of busiest.slice(1)) for (const [status, n] of byStatus) add(rest, status, n);

  const gets = new Map<string, number>();
  for (const g of account.r2Gets) add(gets, g.dimensions.datetimeHour, g.sum.requests);
  const topGet = largest(gets)[0];

  const storage = account.r2Storage
    .map((g) => ({
      date: g.dimensions.date,
      objects: g.max.objectCount,
      bytes: g.max.payloadSize + g.max.metadataSize,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const periodic = account.doPeriodic.map((g) => g.sum);
  const workerAll = account.workerAll[0];
  return {
    window,
    worker: {
      requests: workerAll?.sum.requests ?? 0,
      times: timesOf(workerAll?.quantiles),
      byStatus: account.workerStatus
        .map((g) => ({ status: g.dimensions.status, requests: g.sum.requests, times: timesOf(g.quantiles) }))
        .sort((a, b) => b.requests - a.requests || a.status.localeCompare(b.status)),
      busiestHour: top ? { hour: top.hour, requests: top.requests, byStatus: largest(top.byStatus) } : null,
      rest: {
        hours: hoursTouched(window) - (top ? 1 : 0),
        requests: total(rest),
        byStatus: largest(rest),
      },
      exceptions: exceptionsOf(account.workerHours),
    },
    durableObject: {
      requests: sumOf(account.doStatus.map((g) => g.sum.requests)),
      byStatus: largest(new Map(account.doStatus.map((g) => [g.dimensions.status, g.sum.requests]))),
      rowsRead: sumOf(periodic.map((p) => p.rowsRead)),
      rowsWritten: sumOf(periodic.map((p) => p.rowsWritten)),
      websocketIn: sumOf(periodic.map((p) => p.inboundWebsocketMsgCount)),
      websocketOut: sumOf(periodic.map((p) => p.outboundWebsocketMsgCount)),
      activeSeconds: sumOf(periodic.map((p) => p.activeTime)) / 1e6,
      exceptions: exceptionsOf(account.doHours),
    },
    r2: {
      operations: sumOf(account.r2Ops.map((g) => g.sum.requests)),
      byType: largest(new Map(account.r2Ops.map((g) => [g.dimensions.actionType, g.sum.requests]))),
      busiestGetHour: topGet ? { hour: topGet[0], requests: topGet[1] } : null,
      storage: { first: storage[0] ?? null, last: storage.at(-1) ?? null },
    },
    days: daysOf(window).map(({ date, partial }) => {
      const sample = account.doSql.filter((g) => g.dimensions.date === date).map((g) => g.max.storedBytes);
      const rows = account.doPeriodic.filter((g) => g.dimensions.date === date).map((g) => g.sum);
      return {
        date,
        partial,
        workerRequests: sumOf(
          account.workerHours.filter((g) => g.dimensions.datetimeHour.startsWith(date)).map((g) => g.sum.requests),
        ),
        doRequests: sumOf(account.doDays.filter((g) => g.dimensions.date === date).map((g) => g.sum.requests)),
        rowsRead: sumOf(rows.map((r) => r.rowsRead)),
        rowsWritten: sumOf(rows.map((r) => r.rowsWritten)),
        sqliteBytes: sample.length > 0 ? Math.max(...sample) : null,
        r2Gets: sumOf(
          account.r2Gets.filter((g) => g.dimensions.datetimeHour.startsWith(date)).map((g) => g.sum.requests),
        ),
      };
    }),
  };
}

/** The status Cloudflare gives a request in which the script threw. */
const EXCEPTION_STATUS = "scriptThrewException";

/** The hours among `groups` in which the script threw, oldest first. */
function exceptionsOf(groups: HourlyStatus[]): Exceptions {
  const hours = new Map<string, number>();
  for (const g of groups)
    if (g.dimensions.status === EXCEPTION_STATUS) add(hours, g.dimensions.datetimeHour, g.sum.requests);
  return [...hours].map(([hour, count]) => ({ hour, count })).sort((a, b) => a.hour.localeCompare(b.hour));
}

/** How many hourly buckets the window reaches into, the partial ones at either end included. */
function hoursTouched(window: Window): number {
  return Math.ceil(window.end.getTime() / HOUR_MS) - Math.floor(window.start.getTime() / HOUR_MS);
}

/** Each UTC day from the window's start to its end, and whether the window covers only part of it. */
function daysOf(window: Window): { date: string; partial: boolean }[] {
  const days = [];
  for (let at = Date.parse(utcDate(window.start)); at < window.end.getTime(); at += DAY_MS) {
    days.push({
      date: utcDate(new Date(at)),
      partial: at < window.start.getTime() || at + DAY_MS > window.end.getTime(),
    });
  }
  return days;
}

function timesOf(q: Quantiles | undefined): Times {
  return {
    cpuP50: q?.cpuTimeP50 ?? 0,
    cpuP99: q?.cpuTimeP99 ?? 0,
    wallP50: q?.wallTimeP50 ?? 0,
    wallP99: q?.wallTimeP99 ?? 0,
  };
}

function add(counts: Map<string, number>, key: string, n: number): void {
  counts.set(key, (counts.get(key) ?? 0) + n);
}

function total(counts: Map<string, number>): number {
  return sumOf([...counts.values()]);
}

function sumOf(values: number[]): number {
  return values.reduce((sum, n) => sum + n, 0);
}

/** `counts`, largest first, ties by name. */
function largest(counts: Map<string, number>): Counts {
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** `usage` as the lines `bun run usage` prints, naming only this deployment's Worker, namespace and bucket. */
export function formatUsage(usage: Usage, names: { script: string; namespace: string; bucket: string }): string {
  const { window, worker, durableObject: durable, r2 } = usage;
  const lines = [
    `Cloudflare usage: ${time(window.start)} to ${time(window.end)} (${window.days} day${window.days === 1 ? "" : "s"})`,
    "",
    `Worker ${names.script}`,
    `  ${count(worker.requests)} requests${listed(worker.byStatus.map((s) => [s.status, s.requests]))}`,
  ];
  if (worker.requests > 0) {
    lines.push(`  ${times(worker.times)}`);
    for (const s of worker.byStatus) lines.push(`    ${s.status} ${count(s.requests)}: ${times(s.times)}`);
  }
  if (worker.busiestHour) {
    const { hour, requests, byStatus } = worker.busiestHour;
    lines.push(`  busiest hour ${time(new Date(hour))}: ${count(requests)} requests (${joined(byStatus)})`);
    const { hours, requests: others } = worker.rest;
    const perHour = hours > 0 ? (others / hours).toFixed(1) : "0";
    const statuses = others > 0 ? ` (${joined(worker.rest.byStatus)})` : "";
    lines.push(`  the other ${hours} hours: ${count(others)} requests, ${perHour} an hour${statuses}`);
  }
  if (worker.exceptions.length > 0) lines.push(`  ${exceptionLine(worker.exceptions)}`);
  lines.push(
    "",
    `Durable Object namespace ${names.namespace}`,
    `  ${count(durable.requests)} requests${listed(durable.byStatus)}`,
  );
  if (durable.exceptions.length > 0) lines.push(`  ${exceptionLine(durable.exceptions)}`);
  lines.push(
    `  rows read ${count(durable.rowsRead)} · written ${count(durable.rowsWritten)}`,
    `  WebSocket messages in ${count(durable.websocketIn)} · out ${count(durable.websocketOut)} · active ${count(Math.round(durable.activeSeconds))} s`,
    "",
    `R2 bucket ${names.bucket}`,
    `  ${count(r2.operations)} operations${listed(r2.byType)}`,
  );
  if (r2.busiestGetHour) {
    lines.push(
      `  GetObject busiest hour ${time(new Date(r2.busiestGetHour.hour))}: ${count(r2.busiestGetHour.requests)}`,
    );
  }
  const { first, last } = r2.storage;
  if (!last) lines.push("  stored: no sample in the window");
  else {
    const before = first && first.date !== last.date ? ` (on ${first.date}: ${stored(first)})` : "";
    lines.push(`  stored on ${last.date}: ${stored(last)}${before}`);
  }

  const partly = usage.days.some((day) => day.partial);
  const table = [
    ["UTC day", "Worker", "DO requests", "rows read", "rows written", "SQLite", "R2 GetObject"],
    ...usage.days.map((day) => [
      `${day.date}${day.partial ? "*" : ""}`,
      count(day.workerRequests),
      count(day.doRequests),
      count(day.rowsRead),
      count(day.rowsWritten),
      day.sqliteBytes === null ? "–" : megabytes(day.sqliteBytes),
      count(day.r2Gets),
    ]),
  ];
  const widths = table[0]?.map((_, i) => Math.max(...table.map((row) => row[i]?.length ?? 0))) ?? [];
  lines.push("");
  for (const row of table) {
    lines.push(
      row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  "),
    );
  }
  if (partly) lines.push("* partly in the window");
  return lines.join("\n");
}

/** When the script threw, by the UTC hour. */
function exceptionLine(exceptions: Exceptions): string {
  return `${EXCEPTION_STATUS} by UTC hour: ${exceptions.map((e) => `${time(new Date(e.hour))} ${count(e.count)}`).join(" · ")}`;
}

function time(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** `: a 1 · b 2` after a total, or nothing when there is nothing to list. */
function listed(counts: Counts): string {
  return counts.length > 0 ? `: ${joined(counts)}` : "";
}

function joined(counts: Counts): string {
  return counts.map(([name, n]) => `${name} ${count(n)}`).join(" · ");
}

function times(t: Times): string {
  return `CPU p50 ${duration(t.cpuP50)}, p99 ${duration(t.cpuP99)} · wall p50 ${duration(t.wallP50)}, p99 ${duration(t.wallP99)}`;
}

/** Microseconds, in the largest unit they fill: ms, s, min or h. */
function duration(us: number): string {
  const seconds = us / 1e6;
  if (seconds < 1) return `${(us / 1e3).toFixed(1)} ms`;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

function stored(s: Storage): string {
  return `${count(s.objects)} objects, ${megabytes(s.bytes)}`;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

const API = "https://api.cloudflare.com/client/v4";

if (import.meta.main) {
  const { values } = parseArgs({ options: { days: { type: "string" }, until: { type: "string" } } });
  const token = await deploymentValue("CLOUDFLARE_API_TOKEN");
  const account = await deploymentValue("CF_ACCOUNT_ID");
  /** Says why the command can't run, with neither credential in it, and stops. */
  function refuse(why: string): never {
    let said = why;
    for (const secret of [token, account]) if (secret) said = said.replaceAll(secret, "<redacted>");
    console.error(said);
    process.exit(2);
  }
  try {
    const window = windowOf(values, new Date());
    if (!token || !account) refuse("Needs CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID, in the environment or deploy.env.");
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const script = wrangler.name;
    const bucket = wrangler.r2_buckets[0]?.bucket_name ?? "";
    const className = wrangler.durable_objects.bindings[0]?.class_name ?? "";
    const list = await fetch(`${API}/accounts/${account}/workers/durable_objects/namespaces?per_page=1000`, {
      headers,
    });
    const namespace = householdNamespace((await list.json()) as NamespaceList, { script, className });
    const own = { script, bucket, namespaceId: namespace.id };
    const asked = await fetch(`${API}/graphql`, {
      method: "POST",
      headers,
      body: JSON.stringify(usageQuery(own, window, account)),
    });
    if (!asked.ok) refuse(`Cloudflare's GraphQL Analytics answered ${asked.status}: ${await asked.text()}`);
    console.log(
      formatUsage(readUsage((await asked.json()) as Answer, window), { script, namespace: namespace.name, bucket }),
    );
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
}
