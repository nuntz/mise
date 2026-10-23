# Cooking and Ratings belong to the Slot, and go with its Recipe

`mark_cooked` records when a Slot with a Recipe was cooked, and `rate_recipe` records a Rating (again, meh or never, with an optional note) for a cooked Slot. Both are stored on the Slot, not on the Recipe. A Recipe's last-cooked date and cook count are derived when it is read: the latest date of a cooked Slot that has it, and how many there are. The date that counts is the Slot's, not when someone tapped the button, so marking Tuesday's dinner cooked on Wednesday morning dates it Tuesday.

What was cooked and rated was the Recipe the Slot had, so changing the Slot's Recipe forgets its cooking and Ratings, as it drops its Overrides (ADR 0012). Unmarking a Slot drops its Ratings too: a Rating is a verdict after cooking. Deleting a Recipe removes them. Clearing a Week leaves its cooked Slots as they were, because a cooked Slot is history, not a plan, and clearing must not undo a "never". A Slot dated after today, in the Household's timezone, can't be marked cooked. Marking a Slot cooked again keeps when it was first marked.

A Rating is attributed to the Member the Caller signs in as. That Member's new Rating for the Slot replaces their old one, so a mis-tap can be corrected. A Caller who is no Member, or a call Mise makes itself, rates without a name, and each such Rating is kept. Removing a Member keeps their Ratings without their name, because what the Household thought of a dinner still matters.

The Proposer keeps a cooked dinner as it is (reason "cooked"), even when it isn't Locked. It is given every Rating of each Recipe, oldest first: "never" from anyone rules the Recipe out, and the latest one scores it. This partly reverses ADR 0013, whose consequences expected cooking to replace "planned" as history without changing the Proposer's interface. Recency still counts every dinner planned around the Week, cooked or not. A cooked dinner counts on the date it was cooked, which is its own date, and a past dinner nobody marked cooked most likely was. Counting only cooked dinners would let a forgotten tap bring a dinner back the next week. The interface does change: a dinner says whether it was cooked, so the Proposer can keep it.

## Consequences

- `mark_cooked` and `rate_recipe` announce "plan". They also change the Recipe's last-cooked date and cook count, so a client showing those must refetch the Recipe on "plan" too.
- A Slot's Ratings are its own history. To see every Rating of a Recipe, read the Slots it was cooked for.
