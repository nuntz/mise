# Mise

Family meal planner. See `SPEC.md` for the product and architecture spec.

## Checking your work

- **CI**: `bun run ci:summary` runs `bun run ci` and prints only the failing step's errors and `exit=N`; the full log is in `.ci.log`.
- **Deploy**: after a push, `bun run deployed` waits for that commit's CI run and exits 0 once its `deploy` job succeeds.
- **Agent turns**: `bun run transcript` prints the local Household's recent turns, tool calls (ok/error) and held confirmations; `--costs` adds tokens and cost.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues on nuntz/mise, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
