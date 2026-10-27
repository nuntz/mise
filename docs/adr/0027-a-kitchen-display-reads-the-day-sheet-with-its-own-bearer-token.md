# A Kitchen Display reads the Day Sheet with its own bearer token

A Kitchen Display (nuntz/mise-display) has no way to sign in through Cloudflare Access, so it reads `GET /kitchen-display/v1/day-sheet` with `Authorization: Bearer <token>`. Access bypasses that path, and the Worker routes it before it resolves a Caller. An Access path may also cover the paths under it, so the Worker runs first for all of `/kitchen-display/*` and answers any other path there with a JSON 404, never the app. As with the Calendar Feed (ADR 0019), the Worker calls a household RPC method, `daySheet(token)`, which is not `@callable` and runs no tool.

It differs from the Calendar Feed's token in four ways, because a Kitchen Display is a device sitting in the open rather than a link pasted into a calendar app:

- The token travels in a header, never in the URL, so it stays out of access logs and Sentry (which keeps no `Authorization` header).
- Each Kitchen Display has its own token, with a label and a last-used time, and can be revoked alone. `add_kitchen_display` mints one and returns it once. Only its SHA-256 is stored, so it cannot be shown again, and a revoked row is deleted, so the very next request is refused.
- A wrong token gets a 401 and a Household not set up gets a 409, both in JSON, since the firmware tells the cases apart ("Pair this display again" or "Not set up"). The route never redirects and never answers HTML, which the firmware would reject.
- The token is looked up by its hash rather than compared, which tells nothing about a stored token from the time a refusal takes.

The Day Sheet (`daySheet` in `packages/domain`) carries no Member or Diner names, Allergens, Constraints, Guest details, notes, Override reasons, Ratings, photos or URLs (nuntz/mise-display ADR 0001). A Conflict shows only as `needsReview`. Its schema is strict, so a test that parses a response finds any field added by mistake. `generatedAt` carries the Household's UTC offset at that moment, because the display has no timezone database and works out local times from it.

## Consequences

- Pairing needs no set-up Household. A display paired early gets 409 until set-up is done, then the Day Sheet.
- Every read writes the display's last-used time: one small write an hour per display.
- The hashes are in the nightly export (ADR 0006), so a restored Household keeps its Kitchen Displays paired.
- None of the Kitchen Display tools is offered to the agent: a token shown once must not pass through a model, and pairing is done at the screen.
