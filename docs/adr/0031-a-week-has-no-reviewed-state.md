# A Week has no reviewed state

A proposed Week carried a flag that said whether someone had looked it over since it was last proposed. Proposing, Re-roll, Let Mise choose and Use it up cleared it, and a banner on the Week ("This Week was proposed and hasn't been reviewed yet", with Mark as reviewed) or the agent's `review_week` set it. Nothing else read it: the Grocery List, the Calendar Feed, the Review screen and the Notifications all ignored it. Once ADR 0030 made a dinner pencilled or the Household's own, the grey line of each pencilled dinner's reason showed what Mise still had open, dinner by dinner, and Keep was how the Household settled one. The flag said the same thing about the whole Week, less precisely, and someone had to clear it by hand.

We remove it. A Week no longer stores whether it was reviewed, the banner and `review_week` go, and no Proposal path marks anything. A pencilled dinner's grey line is the only sign of what Mise chose and no one has settled.

This amends ADR 0013 ("Proposing marks the Week as not reviewed until someone marks it reviewed") and ADR 0030 (Let Mise choose and Use it up "mark the Week as not reviewed when it changes a dinner").

## Considered Options

- **A signal that someone has looked.** With two adults, one may look the Week over on Saturday and the other open it on Sunday unable to tell. A Household-wide flag could carry that, but nobody here needs it, and a Keep on every dinner it means would say it with no flag.
- **A banner worked out from the dinners**, such as "3 dinners are pencilled". It repeats the reason lines, and deciding when it goes away is the reviewed flag again.
- **Gating the Grocery List or the Calendar Feed on review.** It would give the flag a job, at the price of a step before shopping that no one asked for.

## Consequences

- A migration drops the column, as `slot.locked` was dropped (ADR 0030). An older Backup is restored with the release that wrote it, then upgraded (ADR 0006); replaying it at its own schema version still migrates it.
- A Re-roll or Use it up that changes no dinner still says so; that never depended on the flag.
- The Notification that next week is proposed still says "Review it before you shop": the verb, not a state.
