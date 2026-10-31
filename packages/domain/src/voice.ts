/**
 * The start of a Voice Session (ADR 0028): the SDP answer for the browser's WebRTC offer, or why
 * none was made. Only a signed-in Caller may start one, one at a time per Household, only on a
 * deployment with an OpenAI key, never when the Household's cap is 0 (`off`), and only while the
 * day's voice minutes last: `until` is when they come back, the Household's next local midnight.
 */
export type VoiceStartReply =
  | { ok: true; value: { sdp: string } }
  | {
      ok: false;
      error:
        | {
            code: "invalid_input" | "not_signed_in" | "not_set_up" | "unavailable" | "off" | "in_use" | "not_started";
            message: string;
          }
        | { code: "spent"; message: string; until: string };
    };

/** What Live bills a session for being created, credited against the time it then runs. */
export const VOICE_START_CHARGE_SECONDS = 15;
