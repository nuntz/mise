/**
 * Prints the Household's recent conversation with its agent: each Member turn (typed or spoken), the
 * tool calls it led to with ok/error, the agent's answer, the Pending Confirmations held along the
 * way, what GPT-Live heard and said in each exchange of a Voice Session, and the Voice Sessions from the
 * first shown turn's day on, newest first (every one, from a local database).
 * Read-only.
 *
 *   bun run transcript [--turns N] [--costs] [--results] [--db <file.sqlite> | --deployed]
 *   bun run transcript --totals [--since <ISO>] [--until <ISO>] [--db <file.sqlite> | --deployed]
 *
 *   --turns N    how many of the latest Member turns to show (default 10)
 *   --costs      each turn's model calls, tokens and cost, and what pi-ai noted on them (a thread
 *                fallback, dropped thinking): a thread that worked leaves no note
 *   --results    each tool call's result, not only failed ones
 *   --totals     instead of the conversation, a window's aggregates only, for the weekly Prod Review:
 *                Member turns, model calls, tokens and cost, tool calls, compactions, Pending
 *                Confirmations, Voice Sessions and voice exchanges, overall and by day. It prints
 *                nothing anyone said, nor a tool's input or result, so its output can be shared
 *   --since      with --totals, where the window starts (default: 7 days before --until); a date
 *                alone starts at midnight in the Household's timezone, whose days the totals are by
 *   --until      with --totals, where the window ends, before it (default: now)
 *   --db         a Household database other than the local one `wrangler dev` stored
 *   --deployed   the deployed Household's, read from its agent log with the service token that
 *                `bun run wizard` keeps in ~/.config/mise/deploy.env (MISE_AGENT_LOG_CLIENT_ID,
 *                MISE_AGENT_LOG_CLIENT_SECRET and MISE_HOSTNAME, each overridden by the environment)
 *
 * A spoken turn is one GPT-Live handed to the agent; what GPT-Live said back follows it. An exchange
 * GPT-Live answered by itself never reached the agent, and shows among the turns as "not handed on".
 * What this prints without --totals is the Household's conversation: it stays in the terminal, never
 * in git or CI logs.
 */
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import {
  AGENT_LOG_PATH,
  AGENT_LOG_TIMEZONE_HEADER,
  type AgentLog,
  KEPT_EXCHANGES,
  localDate,
  startOfLocalDate,
} from "@mise/domain";
import { Glob } from "bun";
import { DEPLOY_ENV, deploymentValue } from "./deployEnv";

const LOCAL_DO = "apps/worker/.wrangler/state/v3/do/mise-Household";
/** How spoken turns were marked before `presentTurn` said "speaking on" (local stores from the spike). */
const SPOKEN = "(Spoken aloud and transcribed, so it may contain mistakes.) ";
/** How far back `--totals` looks when not given `--since`. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Says why the command can't run as asked, and stops. */
function refuse(why: string): never {
  console.error(why);
  process.exit(2);
}

/** An edge of `--totals`' window: a date alone, which begins at the Household's midnight, or a time. */
type Edge = { date: string } | { at: Date };

/** The edge `value` names for `flag`, an ISO 8601 date or time. */
function edgeAsked(flag: string, value: string): Edge {
  const at = Date.parse(value);
  if (Number.isNaN(at)) refuse(`${flag} takes an ISO 8601 date or time, such as 2026-11-06 or 2026-11-06T08:00:00Z.`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { date: value } : { at: new Date(at) };
}

function edgeIn(edge: Edge, timezone: string): Date {
  return "date" in edge ? startOfLocalDate(edge.date, timezone) : edge.at;
}

/** The deployed Household's log, from its agent log route. */
async function deployedLog(query: string): Promise<{ source: string; log: AgentLog; timezone?: string }> {
  const [hostname, clientId, clientSecret] = await Promise.all(
    ["MISE_HOSTNAME", "MISE_AGENT_LOG_CLIENT_ID", "MISE_AGENT_LOG_CLIENT_SECRET"].map(deploymentValue),
  );
  if (!hostname || !clientId || !clientSecret) {
    console.error(
      `No agent log service token in ${DEPLOY_ENV}: re-run \`bun run wizard\` after a deploy, which writes MISE_HOSTNAME, MISE_AGENT_LOG_CLIENT_ID and MISE_AGENT_LOG_CLIENT_SECRET.`,
    );
    process.exit(2);
  }
  const url = `https://${hostname}${AGENT_LOG_PATH}?${query}`;
  const response = await fetch(url, {
    headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
    // Access answers a token it doesn't take with a redirect to its sign-in page.
    redirect: "manual",
  }).catch((error: unknown) => {
    console.error(`Couldn't reach ${url}: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  });
  if (!response.ok) {
    const why =
      response.status === 404
        ? "the Worker didn't take the token: is the deploy that added the agent log done?"
        : "Access didn't take the service token: it may have expired (a year after it was made), or been rotated; re-run `bun run wizard`.";
    console.error(`${url} answered ${response.status}: ${why}`);
    process.exit(2);
  }
  return {
    source: `Deployed Household: ${hostname}`,
    log: (await response.json()) as AgentLog,
    timezone: response.headers.get(AGENT_LOG_TIMEZONE_HEADER) ?? undefined,
  };
}

/**
 * The log of the Household database in `file`, every row of it, and the Household's timezone: before
 * it is set up, UTC, as the deployed log gives it.
 */
function localLog(file: string): { source: string; log: AgentLog; timezone: string } {
  const db = new Database(file, { readonly: true });
  const hasTable = (name: string) =>
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
  if (!hasTable("pi_entries")) {
    console.error(`${file} has no agent conversation (no pi_entries table).`);
    process.exit(2);
  }
  const rows = <T>(table: string, query: string): T[] => (hasTable(table) ? (db.query(query).all() as T[]) : []);
  // Stores from before Voice Sessions were marked running have no `running` column.
  const running =
    hasTable("voice_session") &&
    (db.query("PRAGMA table_info(voice_session)").all() as { name: string }[]).some((c) => c.name === "running");
  const household = hasTable("household")
    ? (db.query("SELECT timezone FROM household LIMIT 1").get() as { timezone: string } | null)
    : null;
  return {
    source: `Household database: ${file}`,
    timezone: household?.timezone ?? "UTC",
    log: {
      pi_entries: rows("pi_entries", "SELECT id, record FROM pi_entries ORDER BY id"),
      pending_confirmation: rows(
        "pending_confirmation",
        "SELECT id, tool, summary, status, created_at FROM pending_confirmation ORDER BY id",
      ),
      voice_session: rows(
        "voice_session",
        `SELECT id, day, seconds, confirmed, ${running ? "running" : "0 AS running"} FROM voice_session ORDER BY rowid DESC`,
      ),
      voice_exchange: rows("voice_exchange", "SELECT * FROM voice_exchange ORDER BY at, id"),
    },
  };
}

type Content = { type: string; text?: string; id?: string; name?: string; arguments?: unknown };
type Message = {
  role: string;
  content: string | Content[];
  timestamp?: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
  /** What pi-ai noted while making the call, such as `anthropic_thread_fallback` with its reason. */
  diagnostics?: { type: string; details?: { reason?: unknown } }[];
};
type Entry = { id: number; kind: string; model: Message[]; data?: { turn?: number; text?: string } };

/**
 * The lines that show `log`'s latest `turns` Member turns, with what happened in and between them,
 * and its Voice Sessions.
 */
export function format(log: AgentLog, options: { turns: number; costs: boolean; results: boolean }): string[] {
  const entries = entriesOf(log);
  // Results are printed with the call that asked for them.
  const results = resultsOf(entries);

  type Turn = { kind: "turn" | "exchange"; at: number; turn?: number; lines: string[] };
  const turns: Turn[] = [];
  let calls = { count: 0, input: 0, cached: 0, output: 0, cost: 0, model: "" };
  // Each note pi-ai left on the turn's calls, by type and reason, and how many calls had it.
  const notes = new Map<string, number>();
  const flushCosts = () => {
    const turn = turns.at(-1);
    if (options.costs && turn && calls.count > 0) {
      turn.lines.push(
        `  [${calls.model}: ${calls.count} call${calls.count === 1 ? "" : "s"}, ${k(calls.input + calls.cached)} in (${k(calls.cached)} cached), ${calls.output} out, $${calls.cost.toFixed(4)}]`,
      );
      if (notes.size > 0) {
        const named = [...notes].map(([note, count]) => (count > 1 ? `${note} ×${count}` : note));
        turn.lines.push(`  [pi-ai noted: ${named.join(", ")}]`);
      }
    }
    calls = { count: 0, input: 0, cached: 0, output: 0, cost: 0, model: "" };
    notes.clear();
  };

  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "mise.turn" && message) {
      flushCosts();
      const { content, header, said, spoken } = readTurn(entry, message);
      // What the turn told the agent was waiting for a tap, once one had been held (`presentTurn`).
      const waiting = content.match(/^\[(?:Waiting for a tap: .*|Nothing is waiting for a tap)\]$/m)?.[0];
      turns.push({
        kind: "turn",
        at: message.timestamp ?? 0,
        turn: entry.data?.turn,
        lines: [
          `Turn ${entry.data?.turn ?? "?"} · ${time(message.timestamp)} · ${spoken ? "spoken" : "typed"} · ${header}`,
          ...(waiting ? [`  ${waiting}`] : []),
          `  > ${said.startsWith(SPOKEN) ? said.slice(SPOKEN.length) : said}`,
        ],
      });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (entry.kind === "pi.compaction") {
      turn.lines.push("  — earlier conversation compacted —");
      continue;
    }
    if (entry.kind !== "pi.assistant" || !message || typeof message.content === "string") continue;

    const usage = usageOf(message);
    if (usage) {
      calls.count += 1;
      calls.input += usage.input + usage.cacheWrite;
      calls.cached += usage.cacheRead;
      calls.output += usage.output;
      calls.cost += usage.cost;
      calls.model = message.model ?? calls.model;
    }
    for (const { type, details } of message.diagnostics ?? []) {
      const note = typeof details?.reason === "string" ? `${type} (${details.reason})` : type;
      notes.set(note, (notes.get(note) ?? 0) + 1);
    }
    if (message.stopReason === "error") {
      turn.lines.push(`  ✗ model error: ${message.errorMessage ?? "unknown"}`);
      continue;
    }
    for (const part of message.content) {
      if (part.type === "toolCall") {
        const result = part.id ? results.get(part.id) : undefined;
        const mark = !result ? "… no result" : result.isError ? "✗" : "✓";
        turn.lines.push(`  ${part.name} ${clip(JSON.stringify(part.arguments ?? {}), 160)} ${mark}`);
        if (result && (result.isError || options.results)) {
          const body = typeof result.content === "string" ? result.content : text(result.content);
          turn.lines.push(`      ${clip(body, options.results ? 400 : 240)}`);
        }
      }
    }
    const answer = text(message.content).trim();
    if (answer && message.stopReason !== "toolUse") turn.lines.push(`  Mise: ${answer}`);
    else if (answer) turn.lines.push(`  (Mise, before its tools: ${clip(answer, 160)})`);
  }
  flushCosts();

  // Each Pending Confirmation shows in the turn it was held in.
  for (const row of log.pending_confirmation) {
    const at = Date.parse(row.created_at);
    const turn = turns.filter((t) => t.at <= at).at(-1);
    turn?.lines.push(`  ⏸ held #${row.id} ${row.tool}: "${row.summary}" (now ${row.status})`);
  }

  // What GPT-Live said of a turn it handed on follows the turn; an exchange it answered by itself
  // shows between the turns, when it happened.
  const between: Turn[] = [];
  for (const exchange of log.voice_exchange) {
    const said = `said "${clip(exchange.said, 400)}"`;
    const turn = exchange.turn !== null && turns.find((t) => t.turn === exchange.turn);
    if (turn) {
      if (exchange.said) turn.lines.push(`  🎙 ${said}`);
      continue;
    }
    const heard = exchange.delegated ? "handed on with no turn" : `heard "${clip(exchange.heard ?? "", 400)}"`;
    const at = Date.parse(exchange.at);
    // Timed, as it follows a turn that may be from another session, hours before.
    between.push({
      kind: "exchange",
      at,
      lines: [`  🎙 ${time(at)} · ${heard} → ${said}${exchange.delegated ? "" : " (not handed on)"}`],
    });
  }

  const shown = turns.slice(-options.turns);
  const from = shown[0]?.at ?? Number.NEGATIVE_INFINITY;
  const lines: string[] = [];
  if (shown.length === 0) lines.push("No Member turns yet.");
  const timeline = [...shown, ...between.filter((item) => item.at >= from)].sort((a, b) => a.at - b.at);
  for (const item of timeline) {
    // A turn starts a block; an exchange between turns follows the one before it.
    lines.push(...(item.kind === "exchange" ? item.lines : ["", ...item.lines]));
  }

  if (log.voice_session.length > 0) {
    lines.push("", "Voice Sessions:");
    for (const s of log.voice_session) {
      lines.push(
        `  ${s.day} ${s.id}: ${s.seconds}s${s.confirmed ? ", confirmed" : ""}${s.running ? ", still running" : ""}`,
      );
    }
  }
  return lines;
}

/** The log's entries, oldest first. */
function entriesOf(log: AgentLog): Entry[] {
  return log.pi_entries.map((row) => JSON.parse(row.record) as Entry);
}

/** Each tool call's result, by the id of the call that asked for it. */
function resultsOf(entries: Entry[]): Map<string, Message> {
  const results = new Map<string, Message>();
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
    }
  }
  return results;
}

/** Reads a Member turn's entry: what the agent was given, its header's first clause, what was said, and how. */
function readTurn(entry: Entry, message: Message): { content: string; header: string; said: string; spoken: boolean } {
  const content = typeof message.content === "string" ? message.content : text(message.content);
  // The header's first clause says who, how and where (`presentTurn`); the rest is guidance.
  const header = content.match(/^\[([^\]]*)\]/)?.[1]?.split("; ")[0] ?? "";
  const said = entry.data?.text ?? content;
  return { content, header, said, spoken: /, speaking on /.test(header) || said.startsWith(SPOKEN) };
}

/** A model call's tokens and cost, as its `usage` gives them. */
function usageOf(
  message: Message,
): { input: number; cacheWrite: number; cacheRead: number; output: number; cost: number } | undefined {
  const { usage } = message;
  if (!usage) return undefined;
  return {
    input: usage.input,
    cacheWrite: usage.cacheWrite,
    cacheRead: usage.cacheRead,
    output: usage.output,
    cost: usage.cost.total,
  };
}

/** A count of model calls, with their tokens and cost. */
export type CallTotals = {
  calls: number;
  failed: number;
  /** Fresh input tokens: neither written to the cache nor read from it. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
};

/** A count of one tool's calls: how many failed, and how many had no result. */
type ToolTotals = { calls: number; failed: number; unanswered: number };

function noToolCalls(): ToolTotals {
  return { calls: 0, failed: 0, unanswered: 0 };
}

/** A window's aggregates of the agent log: counts only, never anything said, asked or answered. */
export type Totals = {
  since: Date;
  until: Date;
  /** The timezone whose days the totals are by. */
  timezone: string;
  /** Member turns, by how they were made and by their Household-local day. */
  turns: { spoken: number; typed: number; byDay: Record<string, { spoken: number; typed: number }> };
  /** Model calls made for the window's turns, by model and by their turn's day. */
  models: { all: CallTotals; byModel: Record<string, CallTotals>; byDay: Record<string, CallTotals> };
  /** The agent's tool calls by tool: how many failed, and how many had no result. */
  tools: Record<string, ToolTotals>;
  compactions: number;
  /** Pending Confirmations held, by tool and then by status. */
  confirmations: Record<string, Record<string, number>>;
  voiceSessions: { count: number; seconds: number; byDay: Record<string, { count: number; seconds: number }> };
  /**
   * Voice exchanges, and the Household-local day of the oldest one kept when the window starts
   * before it and older ones may have been forgotten (`KEPT_EXCHANGES`): null when none were.
   */
  exchanges: { handedOn: number; answeredItself: number; keptSince: string | null };
};

function noCalls(): CallTotals {
  return { calls: 0, failed: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 };
}

/**
 * The aggregates of `log` for the Member turns made from `window.since` until `window.until`, with
 * what was done for them, and the confirmations, exchanges and Voice Sessions of that time, by day in
 * `timezone`. A Voice Session keeps only its day, so it counts when its day is one the window touches.
 */
export function totals(log: AgentLog, window: { since: Date; until: Date }, timezone: string): Totals {
  const since = window.since.getTime();
  const until = window.until.getTime();
  const within = (ms: number) => ms >= since && ms < until;
  const dayOf = (ms: number) => localDate(new Date(ms), timezone);
  const counted: Totals = {
    since: window.since,
    until: window.until,
    timezone,
    turns: { spoken: 0, typed: 0, byDay: {} },
    models: { all: noCalls(), byModel: {}, byDay: {} },
    tools: {},
    compactions: 0,
    confirmations: {},
    voiceSessions: { count: 0, seconds: 0, byDay: {} },
    exchanges: { handedOn: 0, answeredItself: 0, keptSince: null },
  };

  const entries = entriesOf(log);
  const results = resultsOf(entries);
  // The day of the turn the entries since belong to; null while that turn is outside the window.
  let day: string | null = null;
  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "mise.turn" && message) {
      const at = message.timestamp ?? 0;
      day = within(at) ? dayOf(at) : null;
      if (day === null) continue;
      const how = readTurn(entry, message).spoken ? "spoken" : "typed";
      counted.turns[how] += 1;
      slot(counted.turns.byDay, day, () => ({ spoken: 0, typed: 0 }))[how] += 1;
      continue;
    }
    if (day === null) continue;
    if (entry.kind === "pi.compaction") {
      counted.compactions += 1;
      continue;
    }
    if (entry.kind !== "pi.assistant" || !message) continue;

    const usage = usageOf(message);
    const model = message.model ?? "unknown";
    const sums = [
      counted.models.all,
      slot(counted.models.byModel, model, noCalls),
      slot(counted.models.byDay, day, noCalls),
    ];
    for (const sum of sums) {
      sum.calls += 1;
      if (message.stopReason === "error" || message.stopReason === "aborted") sum.failed += 1;
      if (!usage) continue;
      sum.input += usage.input;
      sum.cacheWrite += usage.cacheWrite;
      sum.cacheRead += usage.cacheRead;
      sum.output += usage.output;
      sum.cost += usage.cost;
    }
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || !part.name) continue;
      const result = part.id ? results.get(part.id) : undefined;
      const tool = slot(counted.tools, part.name, noToolCalls);
      tool.calls += 1;
      if (!result) tool.unanswered += 1;
      else if (result.isError) tool.failed += 1;
    }
  }

  for (const row of log.pending_confirmation) {
    if (!within(Date.parse(row.created_at))) continue;
    const byStatus = slot(counted.confirmations, row.tool, (): Record<string, number> => ({}));
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }

  const firstDay = dayOf(since);
  const lastDay = dayOf(until - 1);
  for (const session of log.voice_session) {
    if (session.day < firstDay || session.day > lastDay) continue;
    counted.voiceSessions.count += 1;
    counted.voiceSessions.seconds += session.seconds;
    const onDay = slot(counted.voiceSessions.byDay, session.day, () => ({ count: 0, seconds: 0 }));
    onDay.count += 1;
    onDay.seconds += session.seconds;
  }

  let oldest = Number.POSITIVE_INFINITY;
  for (const exchange of log.voice_exchange) {
    const at = Date.parse(exchange.at);
    oldest = Math.min(oldest, at);
    if (!within(at)) continue;
    if (exchange.delegated) counted.exchanges.handedOn += 1;
    else counted.exchanges.answeredItself += 1;
  }
  // Fewer exchanges than are kept means none were ever forgotten.
  if (log.voice_exchange.length >= KEPT_EXCHANGES && oldest > since) counted.exchanges.keptSince = dayOf(oldest);
  return counted;
}

/** `record[key]`, made by `init` first if there is none. */
function slot<T>(record: Record<string, T>, key: string, init: () => T): T {
  const value = record[key] ?? init();
  record[key] = value;
  return value;
}

/** The lines that show `counted`: counts and names of tools, models and statuses only. */
export function formatTotals(counted: Totals): string[] {
  const days = <T>(byDay: Record<string, T>) => Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
  const howMade = ({ spoken, typed }: { spoken: number; typed: number }) =>
    `${spoken + typed} (${spoken} spoken, ${typed} typed)`;
  const calls = (sum: CallTotals) =>
    `${sum.calls} (${sum.failed} failed), ${sum.input} fresh in, ${sum.cacheWrite} cache written, ${sum.cacheRead} cache read, ${sum.output} out, $${sum.cost.toFixed(4)}`;
  // Names in a column, so the counts after them line up.
  const named = <T>(rows: [string, T][]) => {
    const width = Math.max(0, ...rows.map(([name]) => name.length));
    return rows.map(([name, row]): [string, T] => [name.padEnd(width), row]);
  };
  const sessions = ({ count, seconds }: { count: number; seconds: number }) => `${count}, ${seconds}s`;

  const lines = [
    `Totals from ${time(counted.since.getTime())} until ${time(counted.until.getTime())}, by day in ${counted.timezone}`,
    "",
    `Member turns: ${howMade(counted.turns)}`,
    ...days(counted.turns.byDay).map(([day, made]) => `  ${day}  ${howMade(made)}`),
    "",
    `Model calls: ${calls(counted.models.all)}`,
    "  by model:",
    ...named(Object.entries(counted.models.byModel).sort(([a], [b]) => a.localeCompare(b))).map(
      ([model, sum]) => `    ${model}  ${calls(sum)}`,
    ),
    "  by day:",
    ...days(counted.models.byDay).map(([day, sum]) => `    ${day}  ${calls(sum)}`),
    "",
  ];

  const tools = Object.entries(counted.tools).sort(([a, x], [b, y]) => y.calls - x.calls || a.localeCompare(b));
  const all = tools.reduce(
    (sum, [, tool]) => ({
      calls: sum.calls + tool.calls,
      failed: sum.failed + tool.failed,
      unanswered: sum.unanswered + tool.unanswered,
    }),
    noToolCalls(),
  );
  const outcome = (tool: ToolTotals) =>
    `${tool.calls} (${tool.failed} failed${tool.unanswered ? `, ${tool.unanswered} with no result` : ""})`;
  lines.push(
    `Agent tool calls: ${outcome(all)}`,
    ...named(tools).map(([name, tool]) => `  ${name}  ${outcome(tool)}`),
    "",
  );

  lines.push(`Compactions: ${counted.compactions}`, "");

  const held = Object.entries(counted.confirmations).sort(([a], [b]) => a.localeCompare(b));
  const heldCount = held.reduce((sum, [, byStatus]) => sum + Object.values(byStatus).reduce((a, b) => a + b, 0), 0);
  lines.push(
    `Pending Confirmations: ${heldCount}`,
    ...named(held).map(
      ([tool, byStatus]) =>
        `  ${tool}  ${Object.entries(byStatus)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([status, count]) => `${count} ${status}`)
          .join(", ")}`,
    ),
    "",
  );

  lines.push(
    `Voice Sessions: ${sessions(counted.voiceSessions)}`,
    ...days(counted.voiceSessions.byDay).map(([day, sum]) => `  ${day}  ${sessions(sum)}`),
    "",
  );

  const { handedOn, answeredItself, keptSince } = counted.exchanges;
  const partial = keptSince ? ` (exchanges since ${keptSince} only)` : "";
  lines.push(
    `Voice exchanges${partial}: ${handedOn + answeredItself} (${handedOn} handed on to the agent, ${answeredItself} answered by GPT-Live itself)`,
  );
  return lines;
}

function localDatabase(): string {
  const files = [...new Glob(`${LOCAL_DO}/*.sqlite`).scanSync()].filter((f) => !f.endsWith("metadata.sqlite"));
  if (files.length === 0) {
    console.error(`No local Household under ${LOCAL_DO}: start \`bun run dev\` and talk to Mise first.`);
    process.exit(2);
  }
  if (files.length > 1) {
    console.error(`More than one local Household; pick one with --db:\n${files.join("\n")}`);
    process.exit(2);
  }
  return files[0] as string;
}

function text(content: Content[]): string {
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function time(ms: number | undefined): string {
  return ms ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")}Z` : "?";
}

function k(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      turns: { type: "string" },
      costs: { type: "boolean", default: false },
      results: { type: "boolean", default: false },
      totals: { type: "boolean", default: false },
      since: { type: "string" },
      until: { type: "string" },
      db: { type: "string" },
      deployed: { type: "boolean", default: false },
    },
  });
  if (values.deployed && values.db) refuse("Pick one of --db and --deployed.");

  if (values.totals) {
    if (values.turns !== undefined || values.costs || values.results) {
      refuse("--totals prints aggregates only: it takes no --turns, --costs or --results.");
    }
    const sinceEdge = values.since === undefined ? undefined : edgeAsked("--since", values.since);
    const untilEdge = values.until === undefined ? { at: new Date() } : edgeAsked("--until", values.until);
    const windowIn = (timezone: string) => {
      const until = edgeIn(untilEdge, timezone);
      return { since: sinceEdge ? edgeIn(sinceEdge, timezone) : new Date(until.getTime() - WEEK_MS), until };
    };
    // Until the Household's timezone is known, the earliest the window can start: a date begins
    // earliest where the clock is furthest ahead of UTC.
    const earliest = windowIn("Etc/GMT-14").since;

    const { source, log, timezone } = values.deployed
      ? await deployedLog(`since=${encodeURIComponent(earliest.toISOString())}`)
      : localLog(values.db ?? localDatabase());
    if (!timezone) {
      refuse("The agent log didn't say the Household's timezone: is the deploy that added --totals done?");
    }
    const window = windowIn(timezone);
    if (window.since >= window.until) refuse("--since must be before --until.");
    console.log(source);
    for (const line of formatTotals(totals(log, window, timezone))) console.log(line);
  } else {
    if (values.since !== undefined || values.until !== undefined) refuse("--since and --until go with --totals.");
    const turnCount = Number(values.turns ?? "10");
    if (!Number.isInteger(turnCount) || turnCount <= 0) refuse("--turns takes a positive whole number.");

    const { source, log } = values.deployed
      ? await deployedLog(`turns=${turnCount}`)
      : localLog(values.db ?? localDatabase());
    console.log(source);
    for (const line of format(log, { turns: turnCount, costs: values.costs, results: values.results }))
      console.log(line);
  }
}
