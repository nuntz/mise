/**
 * The weekly Sentry sweep: what production raised, and what it did around it. Read-only.
 *
 *   bun run sentry [--days N]    (default 7)
 *
 * Prints, for the last N days:
 *   - each unresolved issue seen, with its events grouped into incidents and, for each incident, the
 *     tool calls of the 5 minutes before it and the requests that took over 5 s around it
 *     (a WebSocket connection counts as one request, open as long as the connection)
 *   - spans that failed without raising an issue (a failed request the Worker answered itself)
 *   - the busiest minutes for tool calls (5-minute periods past 7 days), where a refetch storm shows
 *     before it resets anything
 *
 * Exits 0 when there is nothing to look at, 1 when there is, 2 when it can't ask Sentry.
 *
 * Needs a Sentry user token with read access (`SENTRY_AUTH_TOKEN`, else `~/.config/mise/sentry-token`)
 * and the deployment's DSN (`SENTRY_DSN`, else the one in `~/.config/mise/deploy.env`). The DSN
 * names the organisation, its region and the project, so nothing about a deployment is kept here.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const CONFIG = join(homedir(), ".config/mise");
/** Events further apart than this belong to different incidents. */
const INCIDENT_GAP_MS = 5 * 60_000;
/** How far before an incident to count tool calls. */
const LEAD_MS = 5 * 60_000;
const SLOW_MS = 5_000;
const BUSIEST = 5;

const { values } = parseArgs({ options: { days: { type: "string", default: "7" } } });
const days = Number(values.days);
if (!Number.isInteger(days) || days <= 0 || days > 90) {
  console.error("--days takes a whole number from 1 to 90.");
  process.exit(2);
}

/** Sentry answers at most about 10,000 buckets, so a sweep longer than a week counts by 5 minutes. */
const bucketMinutes = days <= 7 ? 1 : 5;
const buckets = bucketMinutes === 1 ? "minutes" : `${bucketMinutes}-minute periods`;

const { api, org, project } = await sentryProject();
const token = await sentryToken();
const end = new Date();
const start = new Date(end.getTime() - days * 86_400_000);

type Issue = {
  id: string;
  shortId: string;
  title: string;
  culprit: string | null;
  count: string;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  substatus: string | null;
  permalink: string;
};
type Event = { dateCreated: string };
type SpanRow = Record<string, string | number | null>;

console.log(`Sentry sweep: ${day(start)} to ${day(end)} (${days} days)`);
let attention = 0;

const issues = await get<Issue[]>(`organizations/${org}/issues/`, {
  project,
  statsPeriod: `${days}d`,
  query: "is:unresolved",
  sort: "date",
  limit: "50",
});
console.log(`\nUnresolved issues (${issues.length})`);
if (issues.length === 0) console.log("  none");
for (const issue of issues) {
  attention += 1;
  console.log(
    `\n  ${issue.shortId}  ${issue.substatus ?? "unresolved"}, ${issue.count} events, ${issue.userCount} user${issue.userCount === 1 ? "" : "s"}`,
  );
  console.log(`    ${issue.title}`);
  if (issue.culprit) console.log(`    at ${pathOf(issue.culprit)}`);
  console.log(`    ${issue.permalink}`);

  const events = await get<Event[]>(`organizations/${org}/issues/${issue.id}/events/`, { limit: "100" });
  for (const incident of incidents(events.map((e) => Date.parse(e.dateCreated)))) {
    const span = `${day(new Date(incident.first))} ${clock(incident.first)}${incident.last > incident.first ? ` to ${clock(incident.last)}` : ""}Z`;
    console.log(`    incident ${span}: ${incident.count} event${incident.count === 1 ? "" : "s"}`);
    const before = await spans(
      "span.op:mise.tool",
      incident.first - LEAD_MS,
      incident.first,
      ["span.description", "count()"],
      "-count()",
      6,
    );
    if (before.length > 0) {
      console.log(
        `      tool calls in the ${LEAD_MS / 60_000} minutes before: ${before.map((r) => `${r["count()"]} ${toolName(r)}`).join(", ")}`,
      );
    }
    const slow = await spans(
      `span.op:http.server span.duration:>${SLOW_MS}ms`,
      incident.first - LEAD_MS,
      incident.last + 1000,
      ["timestamp", "span.duration", "span.description"],
      "timestamp",
      10,
    );
    for (const row of slow) {
      console.log(
        `      over ${SLOW_MS / 1000}s: ${clock(Date.parse(String(row.timestamp)))} ${seconds(row["span.duration"])} ${row["span.description"]}`,
      );
    }
  }
}

const failed = mergeIds(
  await spans(
    "!span.status:ok",
    start.getTime(),
    end.getTime(),
    ["span.op", "span.description", "count()", "max(timestamp)"],
    "-count()",
    100,
  ),
);
console.log(`\nFailed spans (${failed.length})`);
if (failed.length === 0) console.log("  none");
for (const row of failed) {
  attention += 1;
  console.log(`  ${row.count}× ${row.op} ${row.description}, last ${time(row.last)}`);
}

const minutes = await get<{ data: [number, { count: number }[]][] }>(`organizations/${org}/events-stats/`, {
  project,
  dataset: "spans",
  start: start.toISOString(),
  end: end.toISOString(),
  query: "span.op:mise.tool",
  interval: `${bucketMinutes}m`,
  yAxis: "count()",
});
const counted = minutes.data.map(([at, [value]]) => ({ at: at * 1000, count: value?.count ?? 0 }));
const total = counted.reduce((sum, minute) => sum + minute.count, 0);
const busy = counted.filter((minute) => minute.count > 0);
console.log(`\nBusiest ${buckets} for tool calls (${total} calls, in ${busy.length} ${buckets})`);
for (const minute of busy.sort((a, b) => b.count - a.count).slice(0, BUSIEST)) {
  console.log(`  ${time(minute.at)}  ${minute.count}`);
}

console.log(
  attention === 0 ? "\nNothing to look at." : `\n${attention} thing${attention === 1 ? "" : "s"} to look at.`,
);
process.exit(attention === 0 ? 0 : 1);

/**
 * Failed spans by what failed, counting a Recipe's photo route or a request's id as one route
 * (`/recipes/:id/photo`), with the latest time any of them failed.
 */
function mergeIds(rows: SpanRow[]): { op: string; description: string; count: number; last: number }[] {
  const merged = new Map<string, { op: string; description: string; count: number; last: number }>();
  for (const row of rows) {
    const op = String(row["span.op"]);
    const description = String(row["span.description"]).replace(/\/\d+(?=\/|$)/g, "/:id");
    const key = `${op} ${description}`;
    const seen = merged.get(key) ?? { op, description, count: 0, last: 0 };
    seen.count += Number(row["count()"]);
    // Aggregated timestamps come back as seconds since the epoch.
    seen.last = Math.max(seen.last, Number(row["max(timestamp)"]) * 1000);
    merged.set(key, seen);
  }
  return [...merged.values()].sort((a, b) => b.count - a.count);
}

/** Groups event times into incidents: runs of events with no gap over `INCIDENT_GAP_MS`. */
function incidents(times: number[]): { first: number; last: number; count: number }[] {
  const groups: { first: number; last: number; count: number }[] = [];
  for (const at of times.sort((a, b) => a - b)) {
    const current = groups.at(-1);
    if (current && at - current.last <= INCIDENT_GAP_MS) {
      current.last = at;
      current.count += 1;
    } else {
      groups.push({ first: at, last: at, count: 1 });
    }
  }
  return groups;
}

async function spans(
  query: string,
  from: number,
  to: number,
  fields: string[],
  sort: string,
  limit: number,
): Promise<SpanRow[]> {
  const params = new URLSearchParams({
    project,
    dataset: "spans",
    start: new Date(from).toISOString(),
    end: new Date(to).toISOString(),
    query,
    sort,
    per_page: String(limit),
  });
  for (const field of fields) params.append("field", field);
  return (await get<{ data: SpanRow[] }>(`organizations/${org}/events/`, params)).data;
}

async function get<T>(path: string, params: Record<string, string> | URLSearchParams): Promise<T> {
  const url = `${api}${path}?${new URLSearchParams(params)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    console.error(`Sentry answered ${response.status} to ${path}: ${(await response.text()).slice(0, 300)}`);
    process.exit(2);
  }
  return (await response.json()) as T;
}

/** The API base, organisation and project, from a DSN like `https://<key>@o<org>.ingest.<region>.sentry.io/<project>`. */
async function sentryProject(): Promise<{ api: string; org: string; project: string }> {
  const dsn = process.env.SENTRY_DSN ?? (await envFileValue(join(CONFIG, "deploy.env"), "SENTRY_DSN"));
  const match = dsn?.match(/^https:\/\/[^@]+@o(\d+)\.ingest\.(?:([a-z]+)\.)?sentry\.io\/(\d+)$/);
  if (!match) {
    console.error("No Sentry DSN: set SENTRY_DSN, or run the deployment wizard (bun run wizard).");
    process.exit(2);
  }
  const [, org, region, project] = match as [string, string, string | undefined, string];
  return { api: `https://${region ? `${region}.` : ""}sentry.io/api/0/`, org, project };
}

async function sentryToken(): Promise<string> {
  if (process.env.SENTRY_AUTH_TOKEN) return process.env.SENTRY_AUTH_TOKEN;
  const file = Bun.file(join(CONFIG, "sentry-token"));
  if (await file.exists()) return (await file.text()).trim();
  console.error(
    `No Sentry token: set SENTRY_AUTH_TOKEN, or save a user token with read access to ${join(CONFIG, "sentry-token")}.`,
  );
  process.exit(2);
}

async function envFileValue(path: string, key: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  const line = (await file.text()).split("\n").find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).replace(/^['"]|['"]$/g, "");
}

/** A culprit URL without its origin, which is a deployment's own hostname. */
function pathOf(culprit: string): string {
  return culprit.replace(/^https?:\/\/[^/]+/, "");
}

function toolName(row: SpanRow): string {
  return String(row["span.description"]).replace(/^tool /, "");
}

function seconds(ms: SpanRow[string] | undefined): string {
  return `${(Number(ms) / 1000).toFixed(1)}s`;
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function time(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

function clock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}
