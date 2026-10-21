// Worker secrets, set per deployment by Pulumi (ADR 0005). Absent in local development and tests.
interface Secrets {
  SENTRY_DSN?: string;
}

interface Env extends Secrets {}

declare namespace Cloudflare {
  interface Env extends Secrets {}
}
