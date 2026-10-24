# A new week start applies from the next Week

The Household can change the day its Weeks start on after setup (`update_household_settings`). Weeks are not stored with their dates. A Week is named by its start date, which keys its row in `week`, its Effort Budget overrides and its Grocery List. Its Slots are keyed by date alone. If Weeks were worked out from today's `weekStartsOn` alone, a change would move every Week ever planned: last month's Grocery Lists would belong to no Week, and this Week's Slots would be split between two.

So a new week start applies from the next Week, and no stored data is rewritten. Weeks already created keep their dates. That means the current Week, and any Week planned after it (one with a `week` row). The last of them runs to its end, then on to the day before the first new start day, so the first Week on the new day follows it with no gap or overlap. That one stretched Week lasts 8 to 13 days. Every other Week lasts seven.

Each change is stored in `week_start_change` as `{ from, stretches }`. From `from` on, Weeks start on `from`'s weekday, and the Week starting on `stretches` runs to the day before `from`. `household.week_starts_on` is the latest start day, and the weekday before the first change is the weekday of its `stretches`. `weekOf(date, calendar)` in `packages/domain` works out any date's Week from these. Callers use it instead of `weekStartOf`, and a Week now has an `endDate`. The Household returns its changes as `weekStartChanges`, so the PWA works out the current and next Week the same way the household does.

A change that no Week has started under yet can be replaced. Changing the start day again before the stretched Week reaches its new start day drops the earlier change and works out a new one from the same Week. Changing it back restores seven-day Weeks. If today is already past the seventh day of the stretched Week, the replacement runs that Week on to the first new start day after today. Today stays in the current Week, and that Week can last up to 20 days.

## Consequences

- A Week can be longer than seven days. Its Slots, the proposer, the Grocery List and the day rail all go by its dates, not by a count of seven. Effort Budgets are per weekday, so a stretched Week has some weekdays twice, each with that weekday's budget.
- "Today" is judged in the Household's timezone as of the change. A timezone and a week start changed together use the new timezone.
- The changes are in the backup like every other table (ADR 0006), so a restored household has the same Weeks.
- A Week made before the change and never stored (nothing planned, no Effort Budget override, no Grocery List) has no row. If it lies after the current Week, it is not kept: it is worked out under the new start day.
