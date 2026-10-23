# A Proposal is fixed by the Week's seed; a re-roll moves to the next seed that changes it

`proposeWeek` is a pure domain function: the Week's dinners, the Recipes, what is planned around the Week, its Effort Budgets, the "use it up" Items, a seed and a choice give one Proposal. The Week stores the seed and choice it was last proposed with (seed 1 and choice "best" the first time). `propose_week` without `reroll` reuses them, so asking again after nothing changed gives the same plan, and asking after an edit (a new Member, a Recipe resolved) gives the plan those inputs call for, not a reshuffle. A re-roll tries the seeds after the stored one until the dinners come out different from how the Week is now. When the best-scoring Recipes leave no choice, it widens the choice from "best" to "any" Recipe that passes the rules. So a re-roll changes something whenever any dinner has more than one Recipe that fits. The choice is stored with the seed, because a seed alone would not reproduce a widened Proposal.

A Proposal fills only dinners that are neither Locked nor decided by hand as Leftovers, eating out or no meal. An unlocked dinner with a Recipe is chosen again, as an unplanned one is. Recurring Recipes are pinned before anything else, ignoring recency and preferring a day within the Effort Budget, but never where a Hard Constraint rules them out. A Recipe that conflicts is never proposed, even where an Override exists. Overrides are reasons a person gave for a Recipe they chose (ADR 0012), so the Proposer can't give one for them.

Mise does not record cooking yet, so a Recipe planned for a dinner within 6 weeks of the Week, before or after it, counts as cooked on that date. Recency then also keeps the next Week, if it was planned first, from repeating this one. Ratings are not recorded yet either, and the Proposer is given none.

Each dinner's reason is structured data (`ProposalReason`): the rule that kept it, or the factors behind its Recipe, or what ruled out every Recipe. It is stored per Slot as JSON and returned on the Slot. The PWA words it through its message catalogue, and the agent can narrate it. Setting a Slot by hand drops its reason, and so do clearing the Week and deleting its Recipe. Proposing marks the Week as not reviewed until someone marks it reviewed.

## Consequences

- The seed and choice are the only state a Proposal leaves besides the Slots and reasons. Restoring an export and proposing again gives the same plan.
- "Use it up" Items are an input to one call and are not stored: a re-roll without them may favour other Recipes.
- Once cooking and Ratings are recorded, they replace "planned" as history and feed the Ratings the Proposer already weighs, without changing its interface.
