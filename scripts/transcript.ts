/**
 * Prints the local Household's recent conversation with its agent, as `wrangler dev` stored it: each
 * Member turn (typed or spoken), the tool calls it led to with ok/error, the agent's answer, the
 * Pending Confirmations held along the way, and recent Voice Sessions. Read-only.
 *
 *   bun run transcript [--turns N] [--costs] [--results] [--db <file.sqlite>]
 *
 *   --turns N    how many of the latest Member turns to show (default 10)
 *   --costs      each turn's model calls, tokens and cost
 *   --results    each tool call's result, not only failed ones
 *   --db         a Household database other than the local one
 *
 * A spoken turn is one GPT-Live handed to the agent. What GPT-Live answered by itself never reaches
 * the agent, so it is not here.
 */
import { Database } from "bun:sqlite";
import { parseArgs } from "node:util";
import { Glob } from "bun";

const LOCAL_DO = "apps/worker/.wrangler/state/v3/do/mise-Household";
/** How spoken turns were marked before `presentTurn` said "speaking on" (local stores from the spike). */
const SPOKEN = "(Spoken aloud and transcribed, so it may contain mistakes.) ";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "10" },
    costs: { type: "boolean", default: false },
    results: { type: "boolean", default: false },
    db: { type: "string" },
  },
});
const turnCount = Number(values.turns);
if (!Number.isInteger(turnCount) || turnCount <= 0) {
  console.error("--turns takes a positive whole number.");
  process.exit(2);
}

const file = values.db ?? localDatabase();
const db = new Database(file, { readonly: true });
const hasTable = (name: string) =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
if (!hasTable("pi_entries")) {
  console.error(`${file} has no agent conversation (no pi_entries table).`);
  process.exit(2);
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

const entries = db
  .query("SELECT record FROM pi_entries ORDER BY id")
  .all()
  .map((row) => JSON.parse((row as { record: string }).record) as Entry);

// Results are printed with the call that asked for them.
const results = new Map<string, Message>();
for (const entry of entries) {
  for (const message of entry.model ?? []) {
    if (message.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
  }
}

type Turn = { at: number; lines: string[] };
const turns: Turn[] = [];
let calls = { count: 0, input: 0, cached: 0, output: 0, cost: 0, model: "" };
const flushCosts = () => {
  const turn = turns.at(-1);
  if (values.costs && turn && calls.count > 0) {
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
      at: message.timestamp ?? 0,
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
      if (result && (result.isError || values.results)) {
        const body = typeof result.content === "string" ? result.content : text(result.content);
        turn.lines.push(`      ${clip(body, values.results ? 400 : 240)}`);
      }
    }
  }
  const answer = text(message.content).trim();
  if (answer && message.stopReason !== "toolUse") turn.lines.push(`  Mise: ${answer}`);
  else if (answer) turn.lines.push(`  (Mise, before its tools: ${clip(answer, 160)})`);
}
flushCosts();

// Each Pending Confirmation shows in the turn it was held in.
if (hasTable("pending_confirmation")) {
  const rows = db.query("SELECT id, tool, summary, status, created_at FROM pending_confirmation ORDER BY id").all() as {
    id: number;
    tool: string;
    summary: string;
    status: string;
    created_at: string;
  }[];
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    const turn = turns.filter((t) => t.at <= at).at(-1);
    turn?.lines.push(`  ⏸ held #${row.id} ${row.tool}: "${row.summary}" (now ${row.status})`);
  }
}

console.log(`Household database: ${file}`);
const shown = turns.slice(-turnCount);
if (shown.length === 0) console.log("No Member turns yet.");
for (const turn of shown) console.log(`\n${turn.lines.join("\n")}`);

if (hasTable("voice_session")) {
  const columns = (db.query("PRAGMA table_info(voice_session)").all() as { name: string }[]).map((c) => c.name);
  const running = columns.includes("running") ? ", running" : "";
  const sessions = db
    .query(`SELECT id, day, seconds, confirmed${running} FROM voice_session ORDER BY rowid DESC LIMIT 5`)
    .all() as { id: string; day: string; seconds: number; confirmed: number; running?: number }[];
  if (sessions.length > 0) {
    console.log("\nLatest Voice Sessions:");
    for (const s of sessions) {
      console.log(
        `  ${s.day} ${s.id}: ${s.seconds}s${s.confirmed ? ", confirmed" : ""}${s.running ? ", still running" : ""}`,
      );
    }
  }
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
