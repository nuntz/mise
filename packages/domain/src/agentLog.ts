/**
 * The Household's conversation as `bun run transcript` reads it: the raw rows of the agent's
 * entries, the Pending Confirmations, the Voice Sessions and what GPT-Live heard and said. It is
 * conversation, not Household data: it reaches only the agent log's route, never the export or Sentry.
 * The Worker answers it and the transcript reads it, so both take it from here.
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

/** How many voice exchanges a Household keeps: enough for the last few days of its talk. */
export const KEPT_EXCHANGES = 300;

/**
 * Where `bun run transcript --deployed` reads the log: outside the Household's path, behind an Access
 * application of its own that admits only the agent log's service token.
 */
export const AGENT_LOG_PATH = "/agent-log";

/** The response header that names the Household's timezone, whose days the log's Voice Sessions are. */
export const AGENT_LOG_TIMEZONE_HEADER = "Mise-Household-Timezone";
