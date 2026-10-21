# Two test runners: bun test for the domain, Vitest in workerd for the Worker

Pure domain logic (`packages/domain`) is tested with `bun test`. Anything touching the Durable Object, SQLite, routes or the Agents SDK is tested with Vitest + `@cloudflare/vitest-plugin` inside real workerd (`bun run test:worker`). `bun test` cannot execute code inside workerd. A fake SQLite adapter (bun:sqlite) would not reproduce DO SQLite's transaction rules, PRAGMA limits or integer precision. So SQL is only ever tested against the real thing.

## Consequences

- `packages/domain` must stay free of Cloudflare and Bun imports so it runs in both runners and in production.
- CI runs `bun test && bun run test:worker`, not `bun test` alone (supersedes the CI line in SPEC.md §2).
