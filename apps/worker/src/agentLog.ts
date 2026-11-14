import { localDate } from "@mise/domain";
import { TURN_ENTRY } from "./agent";
import type { VoiceExchange } from "./voice";

/**
 * The Household's conversation as `bun run transcript` reads it: the raw rows of the agent's
 * entries, the Pending Confirmations, the Voice Sessions and what GPT-Live heard and said. It is
 * conversation, not Household data: it reaches only the agent log's route, never the export or Sentry.
 */
export type AgentLog = {
  pi_entries: { id: number; record: string }[];
  pending_confirmation: { id: number; tool: string; summary: string; status: string; created_at: string }[];
  voice_session: { id: string; day: string; seconds: number; confirmed: number; running: number }[];
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

/**
 * Where `bun run transcript --deployed` reads the log: outside the Household's path, behind an Access
 * application of its own that admits only the agent log's service token.
 */
export const AGENT_LOG_PATH = "/agent-log";

/** How many of the latest Member turns the log gives when it isn't asked for a number. */
const DEFAULT_TURNS = 10;

/** The number of turns `?turns=` asks for: a positive whole number, by default `DEFAULT_TURNS`; null if not one. */
export function turnsAsked(url: URL): number | null {
  const asked = url.searchParams.get("turns");
  if (asked === null) return DEFAULT_TURNS;
  return /^[1-9]\d{0,3}$/.test(asked) ? Number(asked) : null;
}

/** How many exchanges are kept: enough for the last few days of a Household's talk. */
export const KEPT_EXCHANGES = 300;

/** Records what GPT-Live heard and said in one exchange, and forgets those past the latest `KEPT_EXCHANGES`. */
export function recordExchange(sql: SqlStorage, exchange: VoiceExchange): void {
  sql.exec(
    "INSERT INTO voice_exchange (session_id, at, heard, said, delegated, turn) VALUES (?, ?, ?, ?, ?, ?)",
    exchange.session,
    exchange.at,
    exchange.heard,
    exchange.said,
    exchange.delegated ? 1 : 0,
    exchange.turn,
  );
  sql.exec(
    "DELETE FROM voice_exchange WHERE id <= (SELECT id FROM voice_exchange ORDER BY id DESC LIMIT 1 OFFSET ?)",
    KEPT_EXCHANGES,
  );
}

/**
 * The log from the latest `turns` Member turns on: their entries, the confirmations held and the
 * exchanges since the first of them, and the Voice Sessions from its day in `timezone` on, newest
 * first. All of it while there are fewer.
 */
export function agentLog(sql: SqlStorage, turns: number, timezone: string): AgentLog {
  // A Voice Session keeps only the local day it started on, so the first turn's whole day is given.
  const voiceSessionsFrom = (day: string) =>
    sql
      .exec<AgentLog["voice_session"][number]>(
        "SELECT id, day, seconds, confirmed, running FROM voice_session WHERE day >= ? ORDER BY rowid DESC",
        day,
      )
      .toArray();
  // Pi makes its tables with the Household's first turn.
  const hasConversation =
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_entries'").toArray().length > 0;
  if (!hasConversation)
    return { pi_entries: [], pending_confirmation: [], voice_session: voiceSessionsFrom(""), voice_exchange: [] };
  const earliestTurn = sql
    .exec<{ id: number; turn: number; at: number }>(
      `SELECT id, json_extract(record, '$.data.turn') AS turn, json_extract(record, '$.model[0].timestamp') AS at
       FROM pi_entries WHERE json_extract(record, '$.kind') = ?
       ORDER BY id DESC LIMIT 1 OFFSET ?`,
      TURN_ENTRY,
      turns - 1,
    )
    .toArray()[0];
  const firstTurnAt = earliestTurn ? new Date(earliestTurn.at) : undefined;
  const since = firstTurnAt?.toISOString() ?? "";
  return {
    pi_entries: sql
      .exec<AgentLog["pi_entries"][number]>(
        "SELECT id, record FROM pi_entries WHERE id >= ? ORDER BY id",
        earliestTurn?.id ?? 0,
      )
      .toArray(),
    pending_confirmation: sql
      .exec<AgentLog["pending_confirmation"][number]>(
        "SELECT id, tool, summary, status, created_at FROM pending_confirmation WHERE created_at >= ? ORDER BY id",
        since,
      )
      .toArray(),
    voice_session: voiceSessionsFrom(firstTurnAt ? localDate(firstTurnAt, timezone) : ""),
    // A turn's own exchange began a moment before the turn was recorded.
    voice_exchange: sql
      .exec<AgentLog["voice_exchange"][number]>(
        "SELECT * FROM voice_exchange WHERE at >= ? OR turn >= ? ORDER BY at, id",
        since,
        earliestTurn?.turn ?? 0,
      )
      .toArray(),
  };
}
