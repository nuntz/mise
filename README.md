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

## Layout

- `packages/domain`: pure TypeScript: the Household model and the tool registry. No Cloudflare or Bun imports.
- `apps/worker`: the household Durable Object (an Agents SDK `Agent`) and its single `callTool` entry point.
- `apps/web`: the SolidJS PWA.
- `infra`: Pulumi program for a deployment.
