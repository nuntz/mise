# Mise

A self-hosted family meal planner. See `SPEC.md` for the product and architecture.

## Development

Requires Bun and Node.js.

```sh
bun install
bun run dev          # builds the PWA, then runs the Worker with `wrangler dev` on :8787
bun run seed         # sets up the fictional sample Household (fixtures/) on the local Worker
```

For a hot-reloading UI, run `bun run dev` in `apps/web` alongside `wrangler dev` in `apps/worker`.

```sh
bun run lint
bun run typecheck
bun test packages    # domain tests
bun run test:worker  # tool-seam tests in workerd
```

## Backup and restore

At 03:00 Household time the household Durable Object writes a JSON export of all Household data to R2 at `exports/<date>.json` (ADR 0006). To take one by hand or restore one into a fresh deployment:

```sh
curl https://mise.example.com/agents/household/household/export > export.json
curl -X POST -H 'Content-Type: application/json' --data-binary @export.json \
  https://mise.example.com/agents/household/household/restore
```

Restore refuses a household that already holds data. Behind Access, `curl` needs a service token or a `cloudflared access` login.

## Observability

Errors and traces go to Sentry when the `SENTRY_DSN` Worker secret is set. The SDK collects no user info, cookies, bodies, query strings or AI inputs and outputs, and `apps/worker/src/observability.ts` scrubs events and spans again before they leave. There is no other third-party analytics.

## Layout

- `packages/domain`: pure TypeScript: the Household model and the tool registry. No Cloudflare or Bun imports.
- `apps/worker`: the household Durable Object (an Agents SDK `Agent`) and its single `callTool` entry point.
- `apps/web`: the SolidJS PWA.
- `infra`: Pulumi program for a deployment.
