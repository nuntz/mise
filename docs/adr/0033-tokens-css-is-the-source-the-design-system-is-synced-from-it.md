# tokens.css is the source; the Design System is synced from it

ADR 0020 put the tokens in the Mise Design System artifact and had `tokens.css` match it, by hand, with nothing generating one from the other. In use, tokens were added where the screens needed them, in `tokens.css`, and the Design System never heard of them: by November it lacked fifteen the app used (`line-control`, `on-photo`, `thumb-slot`, `title-card` among them), so every design canvas that installed it started from a palette the app had outgrown.

`apps/web/src/styles/tokens.css` is now the source of truth. A token is added or changed there first, and the Design System is then re-synced from the repository: its `tokens.json` carries `meta.source` "github" and the commit it was synced at, and its README says what the sync leaves out (motion, the self-hosted font stacks). Usage notes, the README's prose and anything written on the Design System's page are kept across a re-sync; only values come from the code.

## Considered Options

- **Keep the Design System as the source.** It is where a design starts, but every token the code needed would wait on an edit there first, and in practice none did.
- **Make the Design System read-only, synced by `/design-sync`.** It would rule out edits on the page, but that sync isn't set up here, and a read-only page would leave the Design System stale until it is.

## Consequences

- A change to `tokens.css` leaves the Design System one sync behind until someone re-syncs it, from its page or by asking Claude Code to re-sync it from the repository. Nothing in CI can read the artifact, so nothing checks they agree.
- Kitchen-mode sizes are in each size token's usage on the Design System, since its format keeps one value per size; the type styles keep their `kitchen-` twins.
