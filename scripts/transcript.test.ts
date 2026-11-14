import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentLog, KEPT_EXCHANGES } from "@mise/domain";
import { format, formatTotals, totals } from "./transcript";

const usage = { input: 10, output: 5, cacheRead: 1000, cacheWrite: 0, cost: { total: 0.001 } };

function logOf(...replies: object[]): AgentLog {
  const turn = {
    kind: "mise.turn",
    data: { turn: 7, text: "What's for dinner?" },
    model: [{ role: "user", content: "[Sam, writing on Friday]\nWhat's for dinner?", timestamp: 1 }],
  };
  const entries = [turn, ...replies.map((reply) => ({ kind: "pi.assistant", model: [reply] }))];
  return {
    pi_entries: entries.map((entry, id) => ({ id, record: JSON.stringify(entry) })),
    pending_confirmation: [],
    voice_session: [],
    voice_exchange: [],
  };
}

const reply = (extra: object) => ({
  role: "assistant",
  model: "claude-sonnet-5-5",
  stopReason: "stop",
  timestamp: 2,
  usage,
  content: [{ type: "text", text: "Soup." }],
  ...extra,
});

test("--costs names what pi-ai noted on a turn's model calls, with each note's reason", () => {
  const log = logOf(
    reply({
      diagnostics: [
        { type: "anthropic_thread_fallback", timestamp: 2, details: { reason: "thread_not_found" } },
        { type: "anthropic_input_transformations", timestamp: 2, details: { transformations: [] } },
      ],
    }),
    reply({
      diagnostics: [{ type: "anthropic_thread_fallback", timestamp: 3, details: { reason: "thread_not_found" } }],
    }),
  );
  expect(format(log, { turns: 10, costs: true, results: false })).toContain(
    "  [pi-ai noted: anthropic_thread_fallback (thread_not_found) ×2, anthropic_input_transformations]",
  );
});

test("--costs adds no note line for model calls pi-ai noted nothing on, nor without --costs", () => {
  const quiet = format(logOf(reply({})), { turns: 10, costs: true, results: false });
  expect(quiet.some((line) => line.includes("pi-ai noted"))).toBe(false);
  const noted = logOf(reply({ diagnostics: [{ type: "anthropic_thread_fallback", timestamp: 2 }] }));
  expect(format(noted, { turns: 10, costs: false, results: false }).some((line) => line.includes("pi-ai noted"))).toBe(
    false,
  );
});

/** Each text in the fixture holds a marker of its own, so a test can tell none of it was printed. */
let markers = 0;
const marked = (what: string) => `${what} MARKER-${++markers}`;
const printedMarker = (lines: string[]) => lines.join("\n").match(/MARKER-\d+/)?.[0];

const TORONTO = "America/Toronto";
/** From 00:00 on Tuesday 10 November to 00:00 on Thursday 12 November, in Toronto. */
const WINDOW = { since: new Date("2026-11-10T05:00:00Z"), until: new Date("2026-11-12T05:00:00Z") };

function memberTurn(turn: number, at: string, how: "speaking" | "writing") {
  const said = marked("said");
  return {
    kind: "mise.turn",
    data: { turn, text: said },
    model: [
      {
        role: "user",
        content: `[${marked("Robin")}, ${how} on Tuesday; ${marked("guidance")}]\n${said}`,
        timestamp: Date.parse(at),
      },
    ],
  };
}

function call(model: string, tokens: [number, number, number, number, number], extra: object = {}) {
  const [input, cacheWrite, cacheRead, output, cost] = tokens;
  return {
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        model,
        stopReason: "stop",
        usage: { input, cacheWrite, cacheRead, output, cost: { total: cost } },
        content: [{ type: "text", text: marked("answer") }],
        ...extra,
      },
    ],
  };
}

const toolCall = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: { query: marked("input") } });
const toolResult = (id: string, isError = false) => ({
  kind: "pi.toolResult",
  model: [{ role: "toolResult", toolCallId: id, isError, content: [{ type: "text", text: marked("result") }] }],
});
const asksFor = (...calls: object[]) => ({
  stopReason: "toolUse",
  content: [{ type: "text", text: marked("before tools") }, ...calls],
});

function exchange(id: number, at: string, delegated: boolean, turn: number | null = null) {
  return {
    id,
    session_id: "session_1",
    at,
    heard: delegated ? null : marked("heard"),
    said: marked("GPT-Live said"),
    delegated: delegated ? 1 : 0,
    turn,
  };
}

const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-5-5";

const fixture: AgentLog = {
  pi_entries: [
    // The day before the window.
    memberTurn(1, "2026-11-09T15:00:00Z", "writing"),
    call(SONNET, [1000, 1000, 1000, 1000, 8], asksFor(toolCall("c0", "find_recipes"))),
    toolResult("c0", true),
    { kind: "pi.compaction", model: [], data: { text: marked("summary") } },
    // Tuesday, spoken.
    memberTurn(2, "2026-11-10T14:00:00Z", "speaking"),
    call(SONNET, [100, 50, 1000, 20, 0.25], asksFor(toolCall("c1", "find_recipes"))),
    toolResult("c1"),
    call(SONNET, [10, 0, 2000, 30, 0.5]),
    { kind: "pi.compaction", model: [], data: { text: marked("summary") } },
    // 22:00 on Tuesday in Toronto, Wednesday in UTC; one call failed.
    memberTurn(3, "2026-11-11T03:00:00Z", "writing"),
    call(HAIKU, [5, 0, 0, 0, 0.0625], { stopReason: "error", errorMessage: marked("error"), content: [] }),
    call(HAIKU, [20, 0, 500, 10, 0.125], asksFor(toolCall("c2", "delete_recipe"), toolCall("c3", "add_item"))),
    toolResult("c2", true),
    // Wednesday, spoken.
    memberTurn(4, "2026-11-11T16:00:00Z", "speaking"),
    call(SONNET, [1, 2, 3, 4, 1], asksFor(toolCall("c4", "find_recipes"))),
    toolResult("c4"),
    // Thursday, after the window.
    memberTurn(5, "2026-11-12T06:00:00Z", "speaking"),
    call(HAIKU, [1000, 1000, 1000, 1000, 8], asksFor(toolCall("c5", "add_item"))),
  ].map((entry, id) => ({ id, record: JSON.stringify(entry) })),
  pending_confirmation: [
    {
      id: 1,
      tool: "delete_recipe",
      summary: marked("summary"),
      status: "confirmed",
      created_at: "2026-11-09T15:01:00.000Z",
    },
    {
      id: 2,
      tool: "delete_recipe",
      summary: marked("summary"),
      status: "pending",
      created_at: "2026-11-11T03:01:00.000Z",
    },
    {
      id: 3,
      tool: "delete_recipe",
      summary: marked("summary"),
      status: "confirmed",
      created_at: "2026-11-11T03:02:00.000Z",
    },
    {
      id: 4,
      tool: "clear_week",
      summary: marked("summary"),
      status: "cancelled",
      created_at: "2026-11-11T16:01:00.000Z",
    },
    {
      id: 5,
      tool: "clear_week",
      summary: marked("summary"),
      status: "pending",
      created_at: "2026-11-12T06:01:00.000Z",
    },
  ],
  voice_session: [
    { id: "session_5", day: "2026-11-12", seconds: 1000, confirmed: 1, running: 0 },
    { id: "session_4", day: "2026-11-11", seconds: 30, confirmed: 1, running: 1 },
    { id: "session_3", day: "2026-11-10", seconds: 90, confirmed: 1, running: 0 },
    { id: "session_2", day: "2026-11-10", seconds: 60, confirmed: 0, running: 0 },
    { id: "session_1", day: "2026-11-09", seconds: 1000, confirmed: 1, running: 0 },
  ],
  voice_exchange: [
    exchange(1, "2026-11-09T14:59:00.000Z", false),
    exchange(2, "2026-11-10T13:59:58.000Z", true, 2),
    exchange(3, "2026-11-10T14:05:00.000Z", false),
    exchange(4, "2026-11-11T15:59:58.000Z", true, 4),
    exchange(5, "2026-11-11T16:10:00.000Z", false),
    exchange(6, "2026-11-12T05:59:58.000Z", true, 5),
  ],
};

const tokens = (
  calls: number,
  failed: number,
  input: number,
  cacheWrite: number,
  cacheRead: number,
  output: number,
  cost: number,
) => ({
  calls,
  failed,
  input,
  cacheWrite,
  cacheRead,
  output,
  cost,
});

describe("--totals", () => {
  test("counts the window's Member turns, spoken and typed, by Household-local day", () => {
    expect(totals(fixture, WINDOW, TORONTO).turns).toEqual({
      spoken: 2,
      typed: 1,
      byDay: { "2026-11-10": { spoken: 1, typed: 1 }, "2026-11-11": { spoken: 1, typed: 0 } },
    });
  });

  test("counts the window's model calls, failed calls, tokens and cost, by model and by day", () => {
    expect(totals(fixture, WINDOW, TORONTO).models).toEqual({
      all: tokens(5, 1, 136, 52, 3503, 64, 1.9375),
      byModel: {
        [SONNET]: tokens(3, 0, 111, 52, 3003, 54, 1.75),
        [HAIKU]: tokens(2, 1, 25, 0, 500, 10, 0.1875),
      },
      byDay: {
        "2026-11-10": tokens(4, 1, 135, 50, 3500, 60, 0.9375),
        "2026-11-11": tokens(1, 0, 1, 2, 3, 4, 1),
      },
    });
  });

  test("counts the window's agent tool calls by tool, with how many failed or had no result", () => {
    expect(totals(fixture, WINDOW, TORONTO).tools).toEqual({
      find_recipes: { calls: 2, failed: 0, unanswered: 0 },
      delete_recipe: { calls: 1, failed: 1, unanswered: 0 },
      add_item: { calls: 1, failed: 0, unanswered: 1 },
    });
  });

  test("counts the window's compactions, and its Pending Confirmations by tool and status", () => {
    const counted = totals(fixture, WINDOW, TORONTO);
    expect(counted.compactions).toBe(1);
    expect(counted.confirmations).toEqual({
      delete_recipe: { pending: 1, confirmed: 1 },
      clear_week: { cancelled: 1 },
    });
  });

  test("counts the window's Voice Sessions and their seconds, by day", () => {
    expect(totals(fixture, WINDOW, TORONTO).voiceSessions).toEqual({
      count: 3,
      seconds: 180,
      byDay: { "2026-11-10": { count: 2, seconds: 150 }, "2026-11-11": { count: 1, seconds: 30 } },
    });
  });

  test("counts the window's voice exchanges, handed on to the agent or answered by GPT-Live itself", () => {
    expect(totals(fixture, WINDOW, TORONTO).exchanges).toEqual({ handedOn: 2, answeredItself: 2, keptSince: null });
  });

  test("prints the aggregates, and nothing a Member, the agent or GPT-Live said, nor a tool's input or result", () => {
    const lines = formatTotals(totals(fixture, WINDOW, TORONTO));

    expect(printedMarker(lines)).toBeUndefined();
    expect(lines).toContain("Member turns: 3 (2 spoken, 1 typed)");
    expect(lines).toContain("Voice exchanges: 4 (2 handed on to the agent, 2 answered by GPT-Live itself)");
  });

  test("says the exchanges' totals are partial when the window starts before the oldest exchange kept", () => {
    const kept = Array.from({ length: KEPT_EXCHANGES }, (_, i) =>
      exchange(i + 1, new Date(Date.parse("2026-11-11T15:00:00Z") + i * 1000).toISOString(), false),
    );
    const counted = totals({ ...fixture, voice_exchange: kept }, WINDOW, TORONTO);

    expect(counted.exchanges).toEqual({ handedOn: 0, answeredItself: KEPT_EXCHANGES, keptSince: "2026-11-11" });
    expect(formatTotals(counted)).toContain(
      `Voice exchanges (exchanges since 2026-11-11 only): ${KEPT_EXCHANGES} (0 handed on to the agent, ${KEPT_EXCHANGES} answered by GPT-Live itself)`,
    );
  });

  test("says nothing is partial when fewer exchanges were made than are kept", () => {
    const later = fixture.voice_exchange.filter((e) => e.at >= "2026-11-11");
    expect(totals({ ...fixture, voice_exchange: later }, WINDOW, TORONTO).exchanges.keptSince).toBeNull();
  });
});

test("--totals counts a model call cut short as failed, as one that errored", () => {
  const log: AgentLog = {
    ...fixture,
    pi_entries: [
      memberTurn(1, "2026-11-10T14:00:00Z", "writing"),
      call(SONNET, [1, 0, 0, 0, 0], { stopReason: "aborted", content: [] }),
    ].map((entry, id) => ({ id, record: JSON.stringify(entry) })),
  };
  expect(totals(log, WINDOW, TORONTO).models.all).toMatchObject({ calls: 1, failed: 1 });
});

test("--totals reads a local Household database, by the Household's days, and prints none of its text", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "transcript-")), "household.sqlite");
  const db = new Database(file);
  db.run("CREATE TABLE household (id INTEGER PRIMARY KEY, timezone TEXT NOT NULL)");
  db.run("INSERT INTO household VALUES (1, ?)", [TORONTO]);
  db.run("CREATE TABLE pi_entries (id INTEGER PRIMARY KEY, record TEXT NOT NULL)");
  for (const row of fixture.pi_entries) db.run("INSERT INTO pi_entries VALUES (?, ?)", [row.id, row.record]);
  db.run("CREATE TABLE pending_confirmation (id INTEGER PRIMARY KEY, tool, summary, status, created_at)");
  for (const c of fixture.pending_confirmation) {
    db.run("INSERT INTO pending_confirmation VALUES (?, ?, ?, ?, ?)", [
      c.id,
      c.tool,
      c.summary,
      c.status,
      c.created_at,
    ]);
  }
  // A store from before Voice Sessions were marked running.
  db.run("CREATE TABLE voice_session (id TEXT, day TEXT, seconds INTEGER, confirmed INTEGER)");
  for (const s of [...fixture.voice_session].reverse()) {
    db.run("INSERT INTO voice_session VALUES (?, ?, ?, ?)", [s.id, s.day, s.seconds, s.confirmed]);
  }
  db.run("CREATE TABLE voice_exchange (id INTEGER PRIMARY KEY, session_id, at, heard, said, delegated, turn)");
  for (const e of fixture.voice_exchange) {
    db.run("INSERT INTO voice_exchange VALUES (?, ?, ?, ?, ?, ?, ?)", [
      e.id,
      e.session_id,
      e.at,
      e.heard,
      e.said,
      e.delegated,
      e.turn,
    ]);
  }
  db.close();

  const run = Bun.spawn(
    ["bun", "scripts/transcript.ts", "--totals", "--db", file, "--since", "2026-11-10", "--until", "2026-11-12"],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, exit] = await Promise.all([
    new Response(run.stdout).text(),
    new Response(run.stderr).text(),
    run.exited,
  ]);

  expect({ exit, err }).toEqual({ exit: 0, err: "" });
  const lines = out.split("\n");
  expect(lines).toContain("Totals from 2026-11-10 05:00Z until 2026-11-12 05:00Z, by day in America/Toronto");
  expect(lines).toContain("Member turns: 3 (2 spoken, 1 typed)");
  expect(lines).toContain("Voice Sessions: 3, 180s");
  expect(printedMarker(lines)).toBeUndefined();
});
