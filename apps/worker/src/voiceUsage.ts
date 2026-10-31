import type { LocalDate } from "@mise/domain";
import type { VoiceUsage } from "./voice";

/**
 * The daily voice cap's count: each Voice Session's billed seconds, kept against the Household local
 * day it started on. They are the Household's, so they are exported, with the cap they count toward.
 */

/** Records a session's usage on `day`: its first count, or a newer one in place of the last. */
export function recordVoiceUsage(sql: SqlStorage, day: LocalDate, usage: VoiceUsage): void {
  sql.exec(
    `INSERT INTO voice_session (id, day, seconds, confirmed) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET seconds = excluded.seconds, confirmed = excluded.confirmed`,
    usage.id,
    day,
    usage.seconds,
    usage.confirmed ? 1 : 0,
  );
}

/** The seconds of voice the Household's sessions started on `day` have used. */
export function voiceSecondsOn(sql: SqlStorage, day: LocalDate): number {
  return (
    sql.exec<{ seconds: number | null }>("SELECT sum(seconds) AS seconds FROM voice_session WHERE day = ?", day).one()
      .seconds ?? 0
  );
}
