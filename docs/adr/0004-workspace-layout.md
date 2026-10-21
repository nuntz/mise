# Bun workspace with a pure domain package

The repo is a Bun workspace: `packages/domain` (pure TypeScript: the proposer, grocery builder, ingredient parser, constraint checks and tool schemas), `apps/worker` (Durable Object, tool registry wiring, routes), `apps/web` (SolidJS PWA) and `infra` (Pulumi). The domain package has no Cloudflare or Bun imports. That keeps the deterministic logic fast to test, lets client and Worker share tool types, and keeps the "no vendor lock in the domain layer" promise from SPEC.md enforceable by package boundaries rather than discipline.
