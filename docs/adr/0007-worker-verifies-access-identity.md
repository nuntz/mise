# The Worker verifies the Access token; the Durable Object trusts the Worker

Cloudflare Access signs in Members with Google and puts a signed token in `Cf-Access-Jwt-Assertion`. The Worker verifies that token itself, against the team's published keys, the application's audience tag and the team issuer, rather than trusting that Access sat in front of the request. A route Access does not cover, a misconfigured policy or a forgotten `workers.dev` URL then yields no identity instead of anyone's. The Caller is the token's `email`; service tokens carry none and are refused. `workers_dev` and preview URLs are off as well.

The Worker forwards the Caller to the household Durable Object in a `Mise-Caller` header it always overwrites. Only the Worker can reach the Durable Object, so the DO trusts it. On a WebSocket the DO records the Caller in the connection's state, which survives hibernation, and every tool handler receives `{ caller }`. RPC from inside the deployment (tests, scheduled jobs) has a null Caller.

## Consequences

- The Access team domain and audience tag are Worker secrets (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) that Pulumi computes; without them the Worker refuses every household request, except under `wrangler dev` with `DEV_CALLER_EMAIL`.
- A WebSocket keeps the Caller it opened with for as long as it stays open, even past the token's expiry; Access checks the session again when the PWA reconnects.
- Wrangler, not Pulumi, uploads the secrets (`wrangler deploy --secrets-file`, from a Pulumi output), since the Worker must exist first. A secret dropped from ESC stays on the Worker until removed with `wrangler secret delete`.
- `/cal/*` bypasses Access and is routed before identity is resolved; it authenticates with its own token.

## Considered Options

- Trust the `Cf-Access-Authenticated-User-Email` header: rejected, because anything that reaches the Worker without Access can set it.
