import type { LocalDate } from "@mise/domain";
import type { VoiceUsage } from "./voice";

/**
 * The daily voice cap's count: each Voice Session's billed seconds, kept against the Household local
 * day it started on. They are the Household's, so they are exported, with the cap they count toward.
 */

/** Records a session's usage on `day`: its first count, or a newer one in place of the last. */
export function recordVoiceUsage(sql: SqlStorage, day: LocalDate, usage: VoiceUsage): void {
  sql.exec(
    `INSERT INTO voice_session (id, day, seconds, confirmed, running) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       seconds = excluded.seconds, confirmed = excluded.confirmed, running = excluded.running`,
    usage.id,
    day,
    usage.seconds,
    usage.confirmed ? 1 : 0,
    usage.running ? 1 : 0,
  );
}

/**
 * Ends the sessions still recorded as running: a restart or deploy cut them short, and the household
 * doesn't reattach. Each keeps the last usage seen, unconfirmed. Returns whether there were any.
 */
export function endCutShortVoiceSessions(sql: SqlStorage): boolean {
  return sql.exec("UPDATE voice_session SET running = 0 WHERE running = 1").rowsWritten > 0;
}

/** The seconds of voice the Household's sessions started on `day` have used. */
export function voiceSecondsOn(sql: SqlStorage, day: LocalDate): number {
  return (
    sql.exec<{ seconds: number | null }>("SELECT sum(seconds) AS seconds FROM voice_session WHERE day = ?", day).one()
      .seconds ?? 0
  );
}
