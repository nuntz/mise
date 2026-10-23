# Mise

A household meal planner covering everything that happens in the kitchen: recipes, the plan, groceries and the pantry.

## Household

**Household**:
The single family a Mise deployment serves, with its members, timezone, week start, units and locale.
_Avoid_: Family, account, tenant

**Member**:
A person who belongs to the Household and can be a Diner; may or may not be someone who signs in.
_Avoid_: User, person

**Caller**:
The signed-in person a tool call is made for, known by the email Cloudflare Access vouched for; not necessarily a Member.
_Avoid_: User, current user

**Diner**:
A Member eating a particular Slot.
_Avoid_: Eater, attendee

**Guest**:
A non-Member eating a particular Slot, counted by number with optional Constraints.

**Servings**:
How many portions a Slot needs: one per Diner plus one per Guest.
_Avoid_: Portions, covers

**Constraint**:
A rule about what a Member or Guest can eat; either Hard or Soft.
_Avoid_: Restriction, preference

**Hard Constraint**:
An allergy, intolerance or diet, always naming an Allergen; a Recipe that violates it is excluded, never merely scored down.

**Soft Constraint**:
A dislike; a Recipe that violates it is scored down but can still be chosen.

**Allergen**:
A substance from the canonical list (peanut, milk, sesame, …) that a Hard Constraint can name.

## Recipes and ingredients

**Recipe**:
A dish Mise can plan, with ingredients, steps and a base number of servings.

**Item**:
A canonical grocery thing ("garlic", "eggs", "soy sauce") with its aliases, store section and Allergens.
_Avoid_: Product, food, ingredient (when meaning the canonical thing)

**Store Section**:
An area of the store (produce, dairy, frozen, …); the Household orders its sections in walking order.
_Avoid_: Aisle, category

**Ingredient**:
One line of a Recipe: an amount of an Item, as written in the source and as parsed.
_Avoid_: Item (when meaning a recipe line)

**Unresolved Ingredient**:
An Ingredient not yet matched to an Item; its Allergens are unknown and treated as conflicting.

**Imported Preference**:
How much the Household liked a Recipe before Mise, carried over from its source; separate from Ratings made in Mise.

**Import Run**:
One import of a source's export, logged with how many Recipes it created, updated, skipped and flagged, and what it could not read.

**Import Flag**:
A Recipe an Import Run left for someone to look at: changed in the source after it was edited in Mise, so not overwritten; or possibly the same dish as a Recipe from another source, so kept beside it.
_Avoid_: Conflict, review item

**Rating**:
A verdict on a Recipe after cooking it for a Slot: again, meh or never, with an optional note, given by a Member or by someone unnamed.

## Planning

**Week**:
The run of days from the Household's week start that is planned, shopped and reviewed together.
_Avoid_: Plan (when meaning the week itself)

**Slot**:
One meal on one date (for example, dinner on 2026-10-26); there is exactly one Slot per date and meal.
_Avoid_: Meal (when meaning the planned occurrence), entry

**Conflict**:
A Hard Constraint of a Diner, or of a Slot's Guests, that the Slot's Recipe violates: it contains the Allergen, or its Allergens are unknown.
_Avoid_: Clash, warning

**Override**:
A reason, recorded on a Slot, for planning it despite one Conflict ("we'll make hers without the nuts"); it holds only while the Slot keeps its Recipe.
_Avoid_: Exception, waiver

**Locked Slot**:
A Slot whose Recipe survives a re-proposal.

**Recurring Recipe**:
A Recipe explicitly pinned to come back every week or on a given weekday.
_Avoid_: Favourite (when meaning pinned)

**Effort Budget**:
The most cooking time the Household wants to spend on a given weekday's dinner.

**Leftovers**:
A Slot filled by food cooked for an earlier Slot; the earlier Slot is cooked for both.

**Proposal**:
A suggested set of Recipes for a Week's dinners, with a reason for each choice.

**Re-roll**:
Proposing a Week again from a new seed, for a different Proposal that keeps its Locked Slots.
_Avoid_: Shuffle, regenerate

## Groceries and pantry

**Staple**:
An Item the Household keeps on hand and checks by status (stocked, low, out) rather than by quantity.
_Avoid_: Inventory, pantry item

**Grocery List**:
What to buy for a Week: Ingredients scaled to Servings and merged, plus Staples that are due to be bought.
_Avoid_: Shopping list, cart

**Plan Revision**:
What a Week's Grocery List was built from: the Recipe and Servings of each of its Slots, and those Recipes' Ingredients. A list built from another Plan Revision is out of date.
_Avoid_: Revision (the number change notices carry)

**Have Tick**:
A mark on a Grocery List line saying the Household already has it, so it is not bought.
