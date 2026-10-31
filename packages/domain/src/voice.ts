/**
 * The start of a Voice Session (ADR 0028): the SDP answer for the browser's WebRTC offer, or why
 * none was made. Only a signed-in Caller may start one, one at a time per Household, and only on a
 * deployment with an OpenAI key.
 */
export type VoiceStartReply =
  | { ok: true; value: { sdp: string } }
  | {
      ok: false;
      error: { code: "invalid_input" | "not_signed_in" | "unavailable" | "in_use" | "not_started"; message: string };
    };
