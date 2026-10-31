import type { ChatMessage, ToolResult } from "@mise/domain";
import type { MiseClient } from "./client";
import type { MessageKey } from "./messages";

/** Why a tap on a confirmation didn't go through: what it describes changed, someone already tapped it, or it failed. */
export type TapRefusal = "changed" | "answered" | "unconfirmed";

const REFUSALS: Partial<Record<string, TapRefusal>> = { expired: "changed", not_found: "answered" };

/** What each screen says when a tap didn't go through. */
export const TAP_REFUSALS = {
  changed: "chat.confirmation.changed",
  answered: "chat.confirmation.answered",
  unconfirmed: "chat.confirmation.failed",
} as const satisfies Record<TapRefusal, MessageKey>;

/** A change the agent holds until a person taps it (GLOSSARY: Pending Confirmation). */
export type Confirmation = Extract<ChatMessage, { role: "confirmation" }>;

/** The conversation's confirmations still waiting for a tap. */
export function pendingConfirmations(conversation: readonly ChatMessage[]): Confirmation[] {
  return conversation.filter((turn): turn is Confirmation => turn.role === "confirmation" && turn.status === "pending");
}

/**
 * A person's tap on a Pending Confirmation (ADR 0024): `confirm` runs the call the agent asked for,
 * as them, which only a tap can; `cancel` withdraws it. Either resolves to why it didn't go through,
 * or to nothing when it did.
 */
export function confirmationTaps(client: MiseClient) {
  const answer = async (tap: () => Promise<ToolResult<unknown>>): Promise<TapRefusal | undefined> => {
    let result: ToolResult<unknown> | undefined;
    try {
      result = await tap();
    } catch {
      // Not gone through, as below.
    }
    return result?.ok ? undefined : (REFUSALS[result?.error.code ?? ""] ?? "unconfirmed");
  };
  return {
    confirm: (id: number) => answer(() => client.confirm(id)),
    cancel: (id: number) => answer(() => client.call("cancel_confirmation", { id })),
  };
}
