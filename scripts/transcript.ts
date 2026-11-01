/**
 * Prints the Household's recent conversation with its agent: each Member turn (typed or spoken), the
 * tool calls it led to with ok/error, the agent's answer, the Pending Confirmations held along the
 * way, what GPT-Live heard and said in each exchange of a Voice Session, and recent Voice Sessions.
 * Read-only.
 *
 *   bun run transcript [--turns N] [--costs] [--results] [--db <file.sqlite> | --deployed]
 *
 *   --turns N    how many of the latest Member turns to show (default 10)
 *   --costs      each turn's model calls, tokens and cost
 *   --results    each tool call's result, not only failed ones
 *   --db         a Household database other than the local one `wrangler dev` stored
 *   --deployed   the deployed Household's, read from its agent log with the service token that
 *                `bun run wizard` keeps in ~/.config/mise/deploy.env (MISE_AGENT_LOG_CLIENT_ID,
 *                MISE_AGENT_LOG_CLIENT_SECRET and MISE_HOSTNAME, each overridden by the environment)
 *
 * A spoken turn is one GPT-Live handed to the agent; what GPT-Live said back follows it. An exchange
 * GPT-Live answered by itself never reached the agent, and shows among the turns as "not handed on".
 * What this prints is the Household's conversation: it stays in the terminal, never in git or CI logs.
 */
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { Glob } from "bun";
import { DEPLOY_ENV, deploymentValue } from "./deployEnv";

const LOCAL_DO = "apps/worker/.wrangler/state/v3/do/mise-Household";
/** Must match `AGENT_LOG_PATH` in apps/worker/src/agentLog.ts. */
const AGENT_LOG_PATH = "/agent-log";
/** How spoken turns were marked before `presentTurn` said "speaking on" (local stores from the spike). */
const SPOKEN = "(Spoken aloud and transcribed, so it may contain mistakes.) ";

/** The agent log's rows, as the deployed route answers them and as read from a local store. */
type AgentLog = {
  pi_entries: { id: number; record: string }[];
  pending_confirmation: { id: number; tool: string; summary: string; status: string; created_at: string }[];
  voice_session: { id: string; day: string; seconds: number; confirmed: number; running?: number }[];
  voice_exchange: {
    id: number;
    session_id: string;
    at: string;
    heard: string | null;
    said: string;
    delegated: number;
    turn: number | null;
  }[];
};

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "10" },
    costs: { type: "boolean", default: false },
    results: { type: "boolean", default: false },
    db: { type: "string" },
    deployed: { type: "boolean", default: false },
  },
});
const turnCount = Number(values.turns);
if (!Number.isInteger(turnCount) || turnCount <= 0) {
  console.error("--turns takes a positive whole number.");
  process.exit(2);
}
if (values.deployed && values.db) {
  console.error("Pick one of --db and --deployed.");
  process.exit(2);
}

const { source, log } = values.deployed ? await deployedLog(turnCount) : localLog(values.db ?? localDatabase());
console.log(source);
for (const line of format(log, { turns: turnCount, costs: values.costs, results: values.results })) console.log(line);

/** The deployed Household's log, from its agent log route. */
async function deployedLog(turns: number): Promise<{ source: string; log: AgentLog }> {
  const [hostname, clientId, clientSecret] = await Promise.all(
    ["MISE_HOSTNAME", "MISE_AGENT_LOG_CLIENT_ID", "MISE_AGENT_LOG_CLIENT_SECRET"].map(deploymentValue),
  );
  if (!hostname || !clientId || !clientSecret) {
    console.error(
      `No agent log service token in ${DEPLOY_ENV}: re-run \`bun run wizard\` after a deploy, which writes MISE_HOSTNAME, MISE_AGENT_LOG_CLIENT_ID and MISE_AGENT_LOG_CLIENT_SECRET.`,
    );
    process.exit(2);
  }
  const url = `https://${hostname}${AGENT_LOG_PATH}?turns=${turns}`;
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
  return { source: `Deployed Household: ${hostname}`, log: (await response.json()) as AgentLog };
}

/** The log of the Household database in `file`, every row of it. */
function localLog(file: string): { source: string; log: AgentLog } {
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
  return {
    source: `Household database: ${file}`,
    log: {
      pi_entries: rows("pi_entries", "SELECT id, record FROM pi_entries ORDER BY id"),
      pending_confirmation: rows(
        "pending_confirmation",
        "SELECT id, tool, summary, status, created_at FROM pending_confirmation ORDER BY id",
      ),
      voice_session: rows(
        "voice_session",
        `SELECT id, day, seconds, confirmed${running ? ", running" : ""} FROM voice_session ORDER BY rowid DESC LIMIT 5`,
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
};
type Entry = { id: number; kind: string; model: Message[]; data?: { turn?: number; text?: string } };

/**
 * The lines that show `log`'s latest `turns` Member turns, with what happened in and between them,
 * and its latest Voice Sessions.
 */
function format(log: AgentLog, options: { turns: number; costs: boolean; results: boolean }): string[] {
  const entries = log.pi_entries.map((row) => JSON.parse(row.record) as Entry);

  // Results are printed with the call that asked for them.
  const results = new Map<string, Message>();
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
    }
  }

  type Turn = { kind: "turn" | "exchange"; at: number; turn?: number; lines: string[] };
  const turns: Turn[] = [];
  let calls = { count: 0, input: 0, cached: 0, output: 0, cost: 0, model: "" };
  const flushCosts = () => {
    const turn = turns.at(-1);
    if (options.costs && turn && calls.count > 0) {
      turn.lines.push(
        `  [${calls.model}: ${calls.count} call${calls.count === 1 ? "" : "s"}, ${k(calls.input + calls.cached)} in (${k(calls.cached)} cached), ${calls.output} out, $${calls.cost.toFixed(4)}]`,
      );
    }
    calls = { count: 0, input: 0, cached: 0, output: 0, cost: 0, model: "" };
  };

  for (const entry of entries) {
    const message = entry.model?.[0];
    if (entry.kind === "mise.turn" && message) {
      flushCosts();
      const content = typeof message.content === "string" ? message.content : text(message.content);
      // The header's first clause says who, how and where (`presentTurn`); the rest is guidance.
      const header = content.match(/^\[([^\]]*)\]/)?.[1]?.split("; ")[0] ?? "";
      const said = entry.data?.text ?? content;
      const spoken = /, speaking on /.test(header) || said.startsWith(SPOKEN);
      turns.push({
        kind: "turn",
        at: message.timestamp ?? 0,
        turn: entry.data?.turn,
        lines: [
          `Turn ${entry.data?.turn ?? "?"} · ${time(message.timestamp)} · ${spoken ? "spoken" : "typed"} · ${header}`,
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

    if (message.usage) {
      calls.count += 1;
      calls.input += message.usage.input + message.usage.cacheWrite;
      calls.cached += message.usage.cacheRead;
      calls.output += message.usage.output;
      calls.cost += message.usage.cost.total;
      calls.model = message.model ?? calls.model;
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
    between.push({
      kind: "exchange",
      at: Date.parse(exchange.at),
      lines: [`  🎙 ${heard} → ${said}${exchange.delegated ? "" : " (not handed on)"}`],
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
    lines.push("", "Latest Voice Sessions:");
    for (const s of log.voice_session) {
      lines.push(
        `  ${s.day} ${s.id}: ${s.seconds}s${s.confirmed ? ", confirmed" : ""}${s.running ? ", still running" : ""}`,
      );
    }
  }
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
