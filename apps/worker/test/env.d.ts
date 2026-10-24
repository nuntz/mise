declare namespace Cloudflare {
  interface Env {
    /** A deployed Household's export, set by `bun run check:export` (see vitest.config.ts). */
    STORED_EXPORT?: string;
  }
}
