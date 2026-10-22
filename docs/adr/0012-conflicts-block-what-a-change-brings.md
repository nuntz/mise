# A change is refused only for the Conflicts it brings

`set_slot`, `set_diners` and `set_guests` refuse a change (`constraint_conflict`) when the Slot it leaves has a Conflict that it did not have before and that no Override covers. The error lists each Conflict by person, Allergen and Slot, so the PWA and the agent can name them and ask before overriding. A Conflict the Slot already had stays visible on the Week but blocks nothing. It can arise outside these tools: a Member gains a Constraint, a Recipe gains an Ingredient. Blocking every later edit to that Slot would also block the edit that fixes it, such as taking that Member off.

An Override belongs to the Recipe it was given for. Changing the Slot's Recipe drops every Override, and so does a change that removes its Conflict (taking that person off, say). Putting the person back then needs a new reason. An Override also holds only for the cause it was given for: a reason given while the Recipe's Allergens were unknown ("checked the label") stops covering the Conflict once an Ingredient resolves to an Item that contains the Allergen. A Member's Overrides go when the Hard Constraint behind them is removed, so giving it back needs a new reason. Conflicts are computed when a Slot is read, never stored, so a corrected Item or a resolved Ingredient changes them at once (ADR 0009).

`set_slot` can also set Diners and Guests, so that the PWA saves a Slot as one change checked once, against how the Slot ends up. Otherwise changing the Recipe and taking off the person it conflicts with, in either order, passes through a state that would be refused.

## Consequences

- `add_member` puts a new Member on every Slot that follows the default Diners, and `update_member_constraints` and Recipe edits can create Conflicts too. None of them is refused. Their Conflicts show on the Week until someone overrides them or changes the Slot.
- Guests are one party with shared Constraints, so their Conflicts and Overrides are for "guests", not a Guest.
