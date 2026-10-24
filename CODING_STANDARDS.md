# Coding standards

Read at review. The ADRs in `docs/adr/` and the terms in `GLOSSARY.md` are standards too. What
Biome, tsc and `check:private` already catch is not repeated here.

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
