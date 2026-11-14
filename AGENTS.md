# Mise

Family meal planner. See `SPEC.md` for the product and architecture spec.

## Checking your work

- **CI**: `bun run ci:summary` runs `bun run ci` and prints only the failing step's errors and `exit=N`; the full log is in `.ci.log`.
- **Screens**: `bun run screenshot --screens --only <words> [--variants daylight,kitchen,pseudo]` saves each matching screen of the real app, seeded, as a phone shows it to `dist/screens/`: read the PNGs to see a UI change or where something sits. `--check` lists the screens older than the web source.
- **Deploy**: after a push, `bun run deployed` waits for that commit's CI run and exits 0 once its `deploy` job succeeds, then prints what each `pulumi up` changed.
- **Upgrades**: `bun run upstream-notes <package> <from> <to>` prints the package's changelog and release notes in between; the commit message accounts for each entry (`CODING_STANDARDS.md` → "An upgrade accounts for what upstream changed").
- **Production**: the weekly Prod Review of production is the `/prod-review mise` skill; it inspects only.
- **Agent turns**: `bun run transcript` prints the local Household's recent turns, tool calls (ok/error), held confirmations and what GPT-Live heard and said, including what it answered without handing on; `--costs` adds tokens and cost. `--deployed` reads the deployed Household instead. `--totals [--since <ISO>] [--until <ISO>]` prints only a window's aggregates (turns, model calls, tokens, cost, tool calls, confirmations, voice time; the last 7 days by default) and none of the conversation. When a voice or agent hand test fails, run `bun run transcript --deployed` before asking the person anything. Its output is the Household's conversation: keep it out of commits, issues and Sentry.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on nuntz/mise, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `~/repos/home/docs/agents/triage-labels.md`.

### Agent briefs

Wording a brief or ticket decides for a screen: see `docs/agents/agent-briefs.md`.

### Design canvases

Drawing a screen's directions on a Claude Design canvas, or building the one chosen: see `docs/agents/design-canvas.md`.

### Pi Durable

Changing how the agent uses Pi's harness, its live state or reports, or upgrading Pi: see `docs/research/pi-durable-examples.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `~/repos/home/docs/agents/domain.md`.
