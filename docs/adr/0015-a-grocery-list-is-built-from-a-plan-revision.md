# A Grocery List is built from a plan revision, and rebuilding it is explicit

`build_grocery_list` builds a Week's Grocery List from its plan as it is then, through the pure `buildGroceryList`: every Slot of the Week that holds a Recipe, at any meal, cooked or not, scaled from the Recipe's base Servings to the Slot's Servings and merged into one line per Item. Mass and volume are added up in grams and millilitres and given in the Household's units (grams to the kilo and millilitres to the litre; ounces to the pound, and teaspoons and tablespoons to the quarter cup). They never convert into each other, and counts add up only when they count the same thing, so "2 cloves" and "1 head" of garlic stay two amounts on one line. A pinch or a dash is no measure, so it stays as written. An Unresolved Ingredient can't be merged or scaled, so it is its own line under "other", as written and for the Recipe's base Servings, and the list says so. Resolving it is what makes it scale.

The Week stores the plan revision its list was built from: a fingerprint of what went into it, which is the Recipe and Servings of each Slot, and those Recipes' base Servings and Ingredients. Reading the list compares it with the plan as it is now and says `planChanged` when they differ. Nothing rebuilds the list by itself: a shopper halfway down an aisle must not see lines move because someone changed Thursday at home. A fingerprint is used rather than a counter bumped by every tool that touches a Slot or a Recipe, because it can't miss one, and an edit that changes nothing on the list doesn't flag it: a note, a Lock, a Recipe's title, a dinner moved to another day, or a Recipe put in a Slot nobody eats. The Household's units and Store Sections aren't part of the plan. Sections are applied when the list is read, so reordering them reorders the list at once. The units are applied when it is built.

Rebuilding keeps every line added by hand, and the id and Have Tick of every built line the new plan still needs. A line is the same one if it has the same Item and the same units, with mass and volume counting as one unit each because their unit follows the amount, or, without an Item, the same text. So more lentils by weight are still had, but lentils now also wanted by the cup need checking again. Lines no Recipe needs any more go. Keeping ids means a tick made offline against the old list still lands on its line.

A Have Tick is set to a value with the time it was made, never toggled. The latest time wins, so a tick synced late from a phone that was offline never undoes one made after it.

## Consequences

- Staples are not on the list yet. When they are, they join the build as lines of their own and the fingerprint does not change for them.
- A list is not rebuilt when a Recipe is deleted. Its lines then stop naming that Recipe and the list says the plan changed.
- Lines added by hand show what was typed. The Item it names, if any, only decides its section.
