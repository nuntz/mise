# Mise

A self-hosted family meal planner. See `SPEC.md` for the product and architecture.

## Allergens

Mise checks Recipes against the Household's allergies by looking up each Ingredient in a built-in Item catalogue (`packages/domain/src/catalogue.ts`). An AI drafted that catalogue, and a maintainer reviews it, but **it is not guaranteed to be complete or correct**: brands and recipes vary by country and change over time, and many Items are tagged from what is typical rather than from a specific product's label. Ingredients Mise can't match are treated as conflicting with every allergy, but a matched Item can still be wrong. The same goes for Items your Household adds on the Resolve Ingredients screen: Mise trusts the Allergens chosen there for every Recipe that uses them. Use Mise as a planning aid, not as a substitute for reading labels or for medical advice.

## Development

Requires Bun and Node.js.

```sh
bun install
cp apps/worker/.dev.vars.example apps/worker/.dev.vars   # who you are locally, since there is no Access
bun run dev          # builds the PWA, then runs the Worker with `wrangler dev` on :8787
bun run seed         # sets up the fictional sample Household (fixtures/) on the local Worker
```

For a hot-reloading UI, run `bun run dev` in `apps/web` alongside `wrangler dev` in `apps/worker`.

```sh
bun run lint
bun run typecheck
bun test packages    # domain tests
bun run test:worker  # tool-seam tests in workerd
bun run test:web     # component tests in jsdom
bun run check:private  # no personal emails committed
```

## Deployment

Each deployment is one Household at its own hostname, behind Cloudflare Access with Google sign-in. Every deployment-specific value lives in Pulumi Cloud and Pulumi ESC, never in this repo (ADR 0005); `infra/Pulumi.example.yaml` lists the settings. To set one up:

```sh
bun run wizard
```

The wizard walks you through Pulumi Cloud, a Cloudflare API token, a Google OAuth client, the ESC environment and the GitHub secrets and variables. Its answers stay in `~/.config/mise/deploy.env`. After that, every push to `master` runs `pulumi up` (Access, R2, the custom domain and its DNS record) and then `wrangler deploy`, which uploads the Worker secrets Pulumi computed. On a brand-new deployment the hostname binds on a second `pulumi up` in the same run, once the Worker exists.

The Worker checks the Access token on every request and passes the signed-in email into tool calls (ADR 0007). `/cal/*` skips sign-in.

## Backup and restore

At 03:00 Household time the household Durable Object writes a JSON export of all Household data to R2 at `exports/<date>.json` (ADR 0006). To take one by hand or restore one into a fresh deployment:

```sh
cloudflared access login https://mise.example.com
cloudflared access curl https://mise.example.com/agents/household/household/export > export.json
cloudflared access curl -X POST -H 'Content-Type: application/json' --data-binary @export.json \
  https://mise.example.com/agents/household/household/restore
```

Restore refuses a household that already holds data. The Worker only accepts people signed in through Access, so service tokens don't work here.

## Observability

Errors and traces go to Sentry when the `SENTRY_DSN` Worker secret is set. The SDK collects no user info, cookies, bodies, query strings or AI inputs and outputs, and `apps/worker/src/observability.ts` scrubs events and spans again before they leave. There is no other third-party analytics.

## Layout

- `packages/domain`: pure TypeScript: the Household model and the tool registry. No Cloudflare or Bun imports.
- `apps/worker`: the household Durable Object (an Agents SDK `Agent`) and its single `callTool` entry point.
- `apps/web`: the SolidJS PWA.
- `infra`: Pulumi program for a deployment.
- `scripts`: the deployment wizard and the private-values check.
