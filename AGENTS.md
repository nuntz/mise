# Mise

Family meal planner. See `SPEC.md` for the product and architecture spec.

## Checking your work

- **CI**: `bun run ci:summary` runs `bun run ci` and prints only the failing step's errors and `exit=N`; the full log is in `.ci.log`.
- **Screens**: `bun run screenshot --screens --only <words> [--variants daylight,kitchen,pseudo]` saves each matching screen of the real app, seeded, as a phone shows it to `dist/screens/`: read the PNGs to see a UI change or where something sits. `--check` lists the screens older than the web source.
- **Deploy**: after a push, `bun run deployed` waits for that commit's CI run and exits 0 once its `deploy` job succeeds.
- **Production**: `bun run sentry [--days N]` is the weekly Sentry sweep: unresolved issues grouped into incidents with the tool calls and slow requests around each, failed spans, and the busiest minutes for tool calls. Exits 1 when there is something to look at; file what needs code as a GitHub issue, then `/triage`.
- **Agent turns**: `bun run transcript` prints the local Household's recent turns, tool calls (ok/error), held confirmations and what GPT-Live heard and said, including what it answered without handing on; `--costs` adds tokens and cost. `--deployed` reads the deployed Household instead. When a voice or agent hand test fails, run `bun run transcript --deployed` before asking the person anything. Its output is the Household's conversation: keep it out of commits, issues and Sentry.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on nuntz/mise, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Agent briefs

Wording a brief or ticket decides for a screen: see `docs/agents/agent-briefs.md`.

### Design canvases

Drawing a screen's directions on a Claude Design canvas: see `docs/agents/design-canvas.md`.

### Pi Durable

Changing how the agent uses Pi's harness, its live state or reports, or upgrading Pi: see `docs/research/pi-durable-examples.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
