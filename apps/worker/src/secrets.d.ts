// Worker secrets, set per deployment from Pulumi (ADR 0005). Absent in local development; tests
// set a fictional Access team in vitest.config.ts.
interface Secrets {
  SENTRY_DSN?: string;
  /** The Access team domain that signs identity tokens, e.g. `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience tag. */
  ACCESS_AUD?: string;
  /** The Anthropic API key the agent's model calls are made with. */
  ANTHROPIC_API_KEY?: string;
  /**
   * A Google service account's JSON key, which the Drive folder is shared with. Without it, or
   * without `DRIVE_FOLDER_ID`, there is no Drive sync.
   */
  GOOGLE_SERVICE_ACCOUNT_KEY?: string;
  /** The id of the Drive folder Docs are dropped in: the end of its URL. */
  DRIVE_FOLDER_ID?: string;
  /** Local development only (`.dev.vars`): the email to act as, since `wrangler dev` has no Access. */
  DEV_CALLER_EMAIL?: string;
}

interface Env extends Secrets {}

declare namespace Cloudflare {
  interface Env extends Secrets {}
}
