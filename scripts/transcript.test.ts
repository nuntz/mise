import { expect, test } from "bun:test";
import { type AgentLog, format } from "./transcript";

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
