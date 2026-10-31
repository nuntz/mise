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
            code: "invalid_input" | "not_signed_in" | "not_set_up" | "unavailable" | "off" | "not_started";
            message: string;
          }
        | { code: "in_use"; message: string; by: string | null }
        | { code: "spent"; message: string; until: string };
    };

/**
 * Whether a Voice Session could start now, for the mic to say before anyone taps it: `unavailable`
 * on a deployment without an OpenAI key (or a Household not yet set up), `in_use` while `by` is
 * talking to Mise (`yours` when through the asking device, whose session is still closing once it
 * has hung up), `off` when the cap is 0, and `spent` until the day's minutes come back.
 */
export type VoiceAvailability =
  | { status: "available" }
  | { status: "unavailable" | "off" }
  | { status: "in_use"; by: string | null; yours: boolean }
  | { status: "spent"; until: string };

/** What Live bills a session for being created, credited against the time it then runs. */
export const VOICE_START_CHARGE_SECONDS = 15;
