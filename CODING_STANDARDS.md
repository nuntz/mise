# Coding standards

Read at review. The ADRs in `docs/adr/` and the terms in `GLOSSARY.md` are standards too. What
Biome, tsc and `check:private` already catch is not repeated here.

The web screens' rules (heading roles, rows, the five button roles, banners, what a chip's colour
means) are the comments above their rules in `apps/web/src/styles/app.css`, on top of ADR 0020.
`apps/web/test/styles.test.ts` and the one-primary check in `apps/web/test/primaries.ts` enforce the
mechanical part; review the rest against those comments.

## A test fake keeps the real adapter's contract

A fake does what the real adapter does, no more: same calls, same timing, same failures. A fake
that is kinder than the real thing hides bugs in every screen that leans on it, as the fake client
that fetched on subscribe hid #24. When a fake stands in for an adapter, one test drives both
through the same contract (as `apps/web/test/client.test.ts` does for subscribing).

## Tightening a parser is a change to stored data

A parser that newly refuses a value (a field made required, an enum narrowed, a format made
stricter) refuses rows already stored, and then every read of the Household throws (#23). Such a
change comes with a migration that brings stored rows into line, or with a stated reason why no
stored row can hold the refused value. `check:export` runs before each deploy as a backstop, not
as the plan.

## A refresh keeps what someone is typing

New data reaches a mounted screen as props or signals; a refresh never remounts a form. A keyed
`<Show>` or `<Match>` on an object that every refetch replaces throws away unsaved input (#22).

## CI never calls a model

Code that asks an LLM does it through an interface (`Llm`, or pi-ai's `Models` for the agent), and
every test, in `bun test` and the Worker and web suites, runs on a fake (`FakeLlm`, pi-ai's faux
provider). A model's answer varies from run to run and costs money, so a test that calls one is
neither repeatable nor free. Real models are checked by hand with `bun run eval` on the recorded
fixtures in `fixtures/eval/`, whenever a prompt or a model changes.

## A late answer acts only on what asked for it

A save, fetch or navigation that finishes after the person has moved on touches only the row, form
or page it started from, and only if that is still the one in view. Shared "which row is being
edited" state closed on completion closes whatever is open by then and throws away its input (#78);
a one-off target kept after its opening sends a later visit to a stale place (#77). Each change looks
right alone; check what else can be current when the promise or the history entry resolves.
