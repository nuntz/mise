# A bought dish is a Recipe with one Ingredient

A dinner can be a dish bought finished and only heated: a lasagna from Costco, a rotisserie chicken, a bag of frozen dumplings. Mise plans it as a Recipe marked Ready-made. Its one Ingredient is the product itself ("1 package Kirkland lasagna"), resolved to a Household Item that carries the product's Allergens and Store Section (ADR 0009: a brand-specific product is exactly what the Household's own Items are for, since the shipped catalogue refuses anything whose Allergens vary by brand). Its base Servings are what the pack serves, its steps are how to heat it, if anything, and its effort is the hands-on minutes, not the oven's, so it fits the busy weekday it was bought for. It is not a new kind of Slot, and a Slot still holds one Recipe.

Everything a bought dish needs is what a Slot's Recipe already gets. Its Allergens drive Conflicts and Overrides (ADR 0012). The Grocery List scales it to what the Slot is cooked for and merges it into a line (ADR 0015). It yields Leftovers (ADR 0016). It is marked cooked and rated (ADR 0014), so "the Kirkland one is good" is kept and "never" rules it out. Recency keeps it from coming back the next week, and variety counts its cuisine and protein. The kinds of Slot that hold no Recipe (eating out, no meal) hold nothing to choose, scale or shop, so the Proposer keeps them and the list ignores them; a `bought` kind would have to re-add all of the above beside the Recipe path.

The mark changes four things. The Recipe form gets a short path, "Add a ready-made dish", which asks for the title, the product's name, how many it serves, its Allergens (stated explicitly, "none" included, as a Household Item's must be) and how to heat it, and creates the Household Item and the Recipe in one step. The Recipe sheet, the Week and search say the dish is Ready-made. The Grocery List rounds a count of a packaged unit (package, can, jar) up to whole packs, after merging: half a pack from each of two Slots is one pack, and half a pack alone is one too, because nobody buys half a lasagna. That is a rule of the list, not of Ready-made Recipes, so "half a can of tomatoes" rounds up as well; it amends ADR 0015, which rounds counts of one or more to whole and keeps smaller ones as decimals. The Proposer does not change yet. The mark is there so that a Household setting can later cap the Ready-made dinners in a Week, if Ratings and recency turn out not to keep a freezer from filling it.

Nothing stops a Household from recording a bought dish as a plain Recipe today, and it is planned, shopped and rated the same way. The mark only makes it quick to add and honest to read.

## Consequences

- `readyMade` is a column on `recipe`, false by default, carried by the Backup like any other column (ADR 0006). Imports never set it; a Paprika "Lasagna (Costco)" is marked by hand.
- A Ready-made Recipe's Allergens are only as good as its Household Item's. The form asks for them from the label, and an Item with none stated keeps the Recipe failing closed, as any Unresolved Ingredient does.
- Its Course is `main` unless the form is told otherwise, so the Proposer can choose it (ADR 0022).
- Kitchen mode works unchanged: its steps are how to heat the dish, one step or none.
- A side dish on the same night (a salad with the lasagna) is not this decision. One Slot still holds one Recipe, and cooking, Ratings, Overrides and Leftovers belong to it. Sides, if ever wanted, are a separate decision.

## Considered Options

- **A `bought` kind of Slot**, holding a product and its Servings: rejected. It would need its own Conflicts, grocery line, Leftovers, cooking and Ratings, each a copy of what a Recipe already has.
- **A Slot holding several Recipes** (the lasagna and a salad): rejected for this. It reopens ADRs 0012, 0014 and 0016, which each give the Slot's one Recipe its Overrides, cooking and Leftovers, and a bought dish does not need it.
- **No mark, a plain Recipe**: works, and stays the record underneath. Rejected alone because the form asks for things that do not apply, the list would say "0.5 package", and a later cap on Ready-made dinners would have nothing to count.
