import { type Caller, MemberId, type ResolvedCaller } from "@mise/domain";
import { z } from "zod";

/**
 * Speaker records: who said each Member's turn of the Household's conversation with the agent. The
 * conversation itself lives in Pi's own tables, which the export leaves out; these are the
 * Household's, so they are exported and restored, and conversations per Caller stay a data split.
 */

/** Records a turn `caller` is about to send, and returns its id. */
export function recordTurn(sql: SqlStorage, caller: ResolvedCaller | null, sentAt: string): number {
  return sql
    .exec<{ id: number }>(
      "INSERT INTO chat_turn (email, member_id, speaker, sent_at) VALUES (?, ?, ?, ?) RETURNING id",
      caller?.email ?? null,
      caller?.member?.id ?? null,
      speakerName(caller),
      sentAt,
    )
    .one().id;
}

/** Who a turn names as its speaker: the Member's name, else the Caller's email, else no one. */
function speakerName(caller: ResolvedCaller | null): string | null {
  return caller?.member?.name ?? caller?.email ?? null;
}

/** The speaker the chat shows for a turn. */
export function speakerOfTurn(sql: SqlStorage, turn: number): string | null {
  return (
    sql.exec<{ speaker: string | null }>("SELECT speaker FROM chat_turn WHERE id = ?", turn).toArray()[0]?.speaker ??
    null
  );
}

/** The Caller who sent a turn, whom its tool calls are made as. */
export function callerOfTurn(sql: SqlStorage, turn: number): Caller | null {
  const email = sql
    .exec<{ email: string | null }>("SELECT email FROM chat_turn WHERE id = ?", turn)
    .toArray()[0]?.email;
  return email ? { email } : null;
}

/** A speaker record as stored. */
const ChatTurnRecord = z.object({
  id: z.number().int().positive(),
  email: z.email().nullable(),
  memberId: MemberId.nullable(),
  speaker: z.string().min(1).nullable(),
  sentAt: z.iso.datetime(),
});

/** Every speaker record; parsed, so bad rows throw (a restore checks them this way). */
export function readChatTurns(sql: SqlStorage): z.infer<typeof ChatTurnRecord>[] {
  return sql
    .exec<{ id: number; email: string | null; member_id: number | null; speaker: string | null; sent_at: string }>(
      "SELECT id, email, member_id, speaker, sent_at FROM chat_turn ORDER BY id",
    )
    .toArray()
    .map((row) =>
      ChatTurnRecord.parse({
        id: row.id,
        email: row.email,
        memberId: row.member_id,
        speaker: row.speaker,
        sentAt: row.sent_at,
      }),
    );
}
