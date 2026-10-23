# Leftovers eat the Recipe of the Slot they link to

A Leftovers Slot can link to an earlier Slot that holds a Recipe. That Slot is then cooked for both: its `cookFor` is its own Servings plus those of every Slot linked as its Leftovers, and the Grocery List scales its Recipe to that, even when the Leftovers fall in the next Week. This amends ADR 0015: a Slot is scaled, and fingerprinted, by what it is cooked for rather than by its own Servings. Unlinking (`link_leftovers` with `of: null`) leaves the Slot as Leftovers of nothing in particular and puts the earlier Slot back to its own Servings. A link stays while the Slot's kind stays Leftovers, so editing its note keeps it; `set_slot` to any other kind drops it. The link is stored as the earlier Slot's date and meal, not as a foreign key. Clearing a Week unlinks Leftovers in the next Week of the Slots it clears, and deleting a Recipe unlinks those of the Slots that held it, so a Slot filled again is never cooked for Leftovers nobody linked to it.

Whoever eats Leftovers eats the Recipe they were cooked from, so a Leftovers Slot's Conflicts are that Recipe's with the people eating it. They block as a Recipe's do (ADR 0012): linking Leftovers for someone the Recipe conflicts with, changing who eats them, or changing the earlier Slot's Recipe is refused unless each new Conflict is overridden. Overrides on Leftovers hold while the Recipe they eat stays.

The Proposer places Leftovers for a Recipe that yields them, unless that dinner is already cooked, in the first dinner within two days after it that it is filling anyway (not Locked, cooked or decided by hand), eaten by the same Diners, and whose Guests, if any, the Recipe is safe for. The reason says whose Leftovers they are. Leftovers it placed are not "decided by hand" (ADR 0013): proposing again places them again, or chooses that dinner afresh. Linking by hand, or Locking them, keeps them. A dinner with Leftovers kept that way gets no more, and its Recipe must be safe for whoever eats them.

## Consequences

- The Proposer still chooses a new Recipe for an unlocked dinner whose Leftovers were linked by hand, as long as it is safe for whoever eats them; Locking the dinner keeps it.
- The Proposer only places Leftovers at dinners within the Week. Leftovers at lunch, or in the next Week, are linked by hand.
- A dinner's reason "leftovers" is how Mise tells Leftovers it placed from those linked by hand, so any edit by hand that clears the reason (as `set_slot` and `link_leftovers` do) makes them kept.
