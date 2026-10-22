# Two test runners: bun test for the domain, Vitest for the Worker (in workerd) and the client (in jsdom)

Pure domain logic (`packages/domain`) is tested with `bun test`. Anything touching the Durable Object, SQLite, routes or the Agents SDK is tested with Vitest + `@cloudflare/vitest-plugin` inside real workerd (`bun run test:worker`). `bun test` cannot execute code inside workerd. A fake SQLite adapter (bun:sqlite) would not reproduce DO SQLite's transaction rules, PRAGMA limits or integer precision. So SQL is only ever tested against the real thing.

## Consequences

- `packages/domain` must stay free of Cloudflare and Bun imports so it runs in both runners and in production.
- CI runs `bun test packages && bun run test:worker && bun run test:web`, not `bun test` alone (supersedes the CI line in SPEC.md §2).
- The SolidJS client (`apps/web`) is tested with Vitest too, in jsdom with `@solidjs/testing-library` (`bun run test:web`), because its JSX needs `vite-plugin-solid`'s compiler, which `bun test` can't run. These tests drive components through a fake `MiseClient`, never the Worker.
