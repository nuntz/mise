import { type AgentLog, KEPT_EXCHANGES, localDate } from "@mise/domain";
import { TURN_ENTRY } from "./agent";
import type { VoiceExchange } from "./voice";

/** How many of the latest Member turns the log gives when it isn't asked for a number. */
const DEFAULT_TURNS = 10;

/** What the log is asked for: the latest `turns` Member turns on, or every turn made `since` on. */
export type AgentLogAsked = { turns: number } | { since: Date };

/** An ISO 8601 date, or date and time with its offset, as `?since=` takes it. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * What `url` asks the log for: `?since=` an ISO 8601 time, or `?turns=` a positive whole number, by
 * default `DEFAULT_TURNS`; null if it asks for both, or for either in a way that isn't one.
 */
export function logAsked(url: URL): AgentLogAsked | null {
  const since = url.searchParams.get("since");
  const turns = url.searchParams.get("turns");
  if (since !== null) {
    if (turns !== null || !ISO_TIME.test(since) || Number.isNaN(Date.parse(since))) return null;
    return { since: new Date(since) };
  }
  if (turns === null) return { turns: DEFAULT_TURNS };
  return /^[1-9]\d{0,3}$/.test(turns) ? { turns: Number(turns) } : null;
}

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
 * The log from the latest `turns` Member turns on, all of it while there are fewer, or from the
 * first turn made `since` on, none if there is none: those turns' entries, the confirmations held
 * and the exchanges since the first of them (or since `since`), and the Voice Sessions from that
 * day in `timezone` on, newest first.
 */
export function agentLog(sql: SqlStorage, asked: AgentLogAsked, timezone: string): AgentLog {
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
  const { firstTurn, from } = firstTurnAsked(sql, asked);
  const since = from?.toISOString() ?? "";
  // With no first turn, `turns` gives every entry and `since` none: SQL's `>= NULL` matches nothing.
  const none = "since" in asked ? null : 0;
  return {
    pi_entries: sql
      .exec<AgentLog["pi_entries"][number]>(
        "SELECT id, record FROM pi_entries WHERE id >= ? ORDER BY id",
        firstTurn?.id ?? none,
      )
      .toArray(),
    pending_confirmation: sql
      .exec<AgentLog["pending_confirmation"][number]>(
        "SELECT id, tool, summary, status, created_at FROM pending_confirmation WHERE created_at >= ? ORDER BY id",
        since,
      )
      .toArray(),
    voice_session: voiceSessionsFrom(from ? localDate(from, timezone) : ""),
    // A turn's own exchange began a moment before the turn was recorded.
    voice_exchange: sql
      .exec<AgentLog["voice_exchange"][number]>(
        "SELECT * FROM voice_exchange WHERE at >= ? OR turn >= ? ORDER BY at, id",
        since,
        firstTurn?.turn ?? none,
      )
      .toArray(),
  };
}

/**
 * The first Member turn `asked` for, if there is one, and the time the log's rows are from: that
 * turn's, or `since`.
 */
function firstTurnAsked(
  sql: SqlStorage,
  asked: AgentLogAsked,
): { firstTurn?: { id: number; turn: number; at: number }; from?: Date } {
  const turns = `SELECT id, json_extract(record, '$.data.turn') AS turn, json_extract(record, '$.model[0].timestamp') AS at
    FROM pi_entries WHERE json_extract(record, '$.kind') = ?`;
  const [query, bound] =
    "turns" in asked
      ? [`${turns} ORDER BY id DESC LIMIT 1 OFFSET ?`, asked.turns - 1]
      : [`${turns} AND at >= ? ORDER BY id LIMIT 1`, asked.since.getTime()];
  const firstTurn = sql.exec<{ id: number; turn: number; at: number }>(query, TURN_ENTRY, bound).toArray()[0];
  return { firstTurn, from: "since" in asked ? asked.since : firstTurn && new Date(firstTurn.at) };
}
