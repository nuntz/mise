# November 6 dependency review

This change addresses three findings of the November 6 dependency review:
Seroval, Undici and Hono versions inside published advisory ranges. The baseline is master `733439299dad21aaf9576be5f12e3b6b44b8b75c`.

## Resolutions and compatibility

| Dependency | Before | After | Approach |
| --- | --- | --- | --- |
| seroval | 1.6.11 | 1.7.9 | Root override |
| seroval-plugins | 1.6.11 | 1.7.8 | Root override |
| undici (jsdom) | 8.12.3 | 8.12.4 | Within jsdom's declared range |
| undici (Miniflare) | 7.29.1 | 7.30.2 | Override scoped to Miniflare |
| undici (node-gyp) | 6.29.1 | 6.29.1 | Already outside the reviewed affected ranges |
| hono | 4.13.13 | 4.13.16 | Within MCP SDK's declared range |

Upstream advisories were rechecked before editing:
[Seroval RegExp decoding](https://github.com/lxsmnsyc/seroval/security/advisories/GHSA-72px-vh6m-89wc),
[plugin amplification](https://github.com/lxsmnsyc/seroval/security/advisories/GHSA-g966-mc3v-w67r),
[Undici 8.12.4](https://github.com/nodejs/undici/releases/tag/v8.12.4),
[Undici 7.30.2](https://github.com/nodejs/undici/releases/tag/v7.30.2), and
[Hono 4.13.16](https://github.com/honojs/hono/releases/tag/v4.13.16).

Even Solid 1.9.18 still requests Seroval 1.6.x, and the newest published Miniflare
5.20261104.0-beta still pins Undici 7.30.1. These overrides are temporary tested
exceptions to the parents' ranges. Remove them when compatible parent releases
require patched versions, after checking every resolved copy again. The plugin's
Seroval peer range remains satisfied. The scoped override preserves Undici's three
major versions; it does not substitute Undici 8 under Miniflare or node-gyp.
Bun 1.4.4 writes lockfile format 3 for the scoped override; use the repository's
pinned Bun version. The Sentry Durable Object patch is unchanged.

## Exposure assessment

The web entrypoint renders a browser Solid SPA. No application Seroval import,
server rendering, or untrusted Seroval decoding was found. Undici comes through
jsdom, Miniflare and node-gyp; npm Undici is distinct from Workers' built-in fetch.
Hono comes through the MCP SDK, but no application Hono routes, middleware or
PreparedRegExpRouter data were found.

A local Wrangler dry-run bundle's metafile has no inputs from Seroval, its plugins,
Undici or Hono. A separate Vite production build with source maps likewise has no
sources from those packages (109 sources inspected). Sentry has Hono integration
files, which are not the Hono package. These observations concern the local build,
not an independently retrieved production artifact.

The Worker checks Access before `routeAgentRequest`; calendar and Day Sheet paths
have their own token checks. Identity tests cover missing/invalid Access tokens
and now also paths that resolve to the Household: nested and encoded paths beneath
it, and dot segments climbing out of the calendar and Day Sheet paths. Paths that
only look like the Household (an encoded slash under a bypassed path, a near-miss
name, another agent instance) get 404. No production exploit path or Access bypass
has been established. Deployment and live-artifact verification remain separate.

## Local validation

Using Bun 1.4.4, `bun install --frozen-lockfile` and `bun run ci:summary` passed:
lint, workspace/script typechecks, private-value and web-call checks, 393 domain
tests, the web build, 635 Worker tests and 397 web tests. One stored-export Worker
test was skipped without a supplied export. No production data was fetched.
The new path identity cases passed. Installed-package
resolution also confirmed Miniflare uses Undici 7.30.2, jsdom uses 8.12.4, and
Solid uses Seroval 1.7.9 with plugins 1.7.8.

The bundle inspections used `wrangler deploy --dry-run --metafile` and
`vite build --sourcemap`, with outputs outside the repository. No deployment was
performed. See the PR checks for CI against the final commit.

## Audit follow-up

`bun audit --json` no longer reports Undici after the update, but still exits 1
for four pre-existing findings outside the three review findings:

| Package | Path | Audit finding |
| --- | --- | --- |
| body-parser 2.3.0 | MCP SDK → Express | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828), high |
| glob 13.0.6 | Pulumi → npm tooling | [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), moderate |
| minimatch 10.2.6 | Pulumi → npm tooling | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), moderate |
| zod 4.6.5 | @cloudflare/vitest-plugin | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), high |

Application Zod remains 4.6.7. The local Worker bundle contains none of the first
three packages; the affected Zod copy belongs to test tooling. These findings need
their own compatibility and reachability assessment. Audit did not report the
newest Seroval/Hono advisories, so the scan alone is not evidence of their absence;
the upstream fixes and all resolved versions were checked independently.
