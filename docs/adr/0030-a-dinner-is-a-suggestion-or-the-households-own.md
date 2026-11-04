# A dinner is a Suggestion or the Household's own, and a Week keeps its Use it up

A proposed Week had three controls whose difference took an ADR to explain: Re-roll (a new seed), Propose again (the same seed, after picking Use it up Items), and Lock (keep a dinner through both). A Recipe chosen by hand was not kept unless it was Locked as well, and Use it up lived only on the screen that picked it. We replace that with two states and one stored input.

A dinner is either a **Suggestion**, which Mise chose and a later Proposal may change, or the **Household's own**, which no Proposal changes. A dinner is a Suggestion exactly when it has a reason (`ProposalReason`). That reason is the grey line on the Week, so the line is how anyone tells the two apart. A Proposal fills only Suggestions and unplanned dinners. It leaves every other dinner as it is and writes no reason for it, so the `locked`, `kept` and `cooked` reason kinds are retired.

A dinner becomes the Household's own when someone:

- changes its kind or Recipe (`set_slot`);
- **Keeps** it (`keep_slot`);
- links Leftovers to it by hand (`link_leftovers`);
- or cooks it (`mark_cooked`).

Each of these deletes its reason. Editing a Suggestion's note, Diners or Guests does not. Saying who eats a dinner is not choosing it. "Let Mise choose" hands a dinner back: it proposes that one dinner, preferring a Recipe other than the one it had, and marks the Week as not reviewed when it changes a dinner.

Lock is retired: `lock_slot`, the Slot's `locked`, and the Proposer's `locked` input all go. A Lock was someone's decision to keep a dinner, so the migration deletes the reason of every Locked dinner, which makes it the Household's own. A Locked unplanned dinner becomes plain unplanned, which a Proposal fills.

The Week stores its **Use it up**, the Items on hand that its Proposals favour Recipes for. Each Week starts with none. `set_use_up` stores them. Once the Week has been proposed, it also proposes the Week again from the same seed, so the plan adjusts to the Items without being reshuffled, and marks the Week as not reviewed when it changes a dinner. `propose_week` reads the stored Use it up and loses its `useUp` argument. That includes the morning job's Proposal, which therefore uses Items set before it runs. A Re-roll moves to a new seed as before (ADR 0013), but it changes only Suggestions and fills unplanned dinners. When a Re-roll or `set_use_up` changes no dinner, the result says so, rather than returning the same Week as if something had happened.

This amends ADR 0013 in three places:

- Its "an unlocked dinner with a Recipe is chosen again" no longer holds: such a dinner is the Household's own.
- Its "use it up Items are … not stored" is reversed.
- Its reasons no longer include "the rule that kept it".

It amends ADR 0016 in two:

- A dinner whose Leftovers were linked by hand is the Household's own, so the Proposer never chooses it again, and the fallback that kept its Recipe when nothing else was safe has no case left.
- Keeping Leftovers the Proposer placed is Keep, not Lock.

## Considered Options

- **Lock every dinner chosen by hand.** That would be one mechanism, but most cards would carry a lock, and Lock would be a word a new person learns only to find that it means "yours".
- **Three labels: Mise's pick, Locked, and unmarked.** That is two behaviours shown three ways. Locked and chosen by hand both stay on a Re-roll.
- **Keep as `set_slot` with the Recipe the dinner already has.** It would need no new tool, but the Slot editor sends `set_slot` for a note-only change too, so the Household could not edit a Suggestion's note without making it its own.
- **Use it up for one call, as ADR 0013 had it.** It needs nothing stored, but it was lost on reload, on another device and in the morning job's Proposal, and it needed a second control, Propose again, to set it after a Week was proposed.

## Consequences

- Every path that makes a dinner the Household's own must delete its reason, and the Proposer must write none for dinners it leaves. A reason left behind would show the grey line on a dinner a Re-roll will not change.
- A note stays with its Slot, so a Re-roll that changes a Suggestion keeps the note someone wrote on it.
- Keep is offered only on Suggestions with a Recipe or Leftovers. An unplanned Suggestion ("nobody's eating", "no Recipe fit") would be filled by the next Proposal anyway, so keeping it would do nothing.
- Re-roll is disabled only when every dinner is the Household's own and planned, or nobody is eating it. A dinner no Recipe fit still counts, because a Recipe added since may fit.
- The Proposer still needs to know which dinners have Leftovers linked by hand, so that it places no more Leftovers after them. It no longer needs to know who eats those Leftovers.
- Use it up is a table like any other, so the Backup carries it (ADR 0006).

## Amended by ADR 0031

A Week has no reviewed state: nothing marks it reviewed or not reviewed, and a Suggestion's grey line is the only sign of what Mise chose and no one has settled.

## Renamed

A Suggestion in this ADR is now a **pencilled dinner**, so that Suggestion names only an LLM's guess at an Unresolved Ingredient's Item (ADR 0023). The decision is unchanged.

## Amended by ADR 0032

A pencilled dinner is marked on the Week by a Pencilled chip and an italic name, not by its reason's grey line. The reason is in the dinner's Recipe sheet, or on the card when it has no Recipe to open.
