# The Item catalogue ships in code

The canonical Items (ADR 0001) are a hand-curated list in `packages/domain` (`catalogue.ts`, matched by `items.ts`), not rows in the household database. The ingredient parser is pure domain code and matches against that list directly, so it runs the same in `bun test`, the Worker and the PWA. An Item's key is stable like an Allergen's: Ingredients store it, so a key is never renamed or removed, and a restore rejects an Ingredient naming a key the catalogue doesn't have.

Only Items whose Allergens are dependable whatever the brand go in. Things that vary (bread, stock cubes, sausages, curry paste) stay out, so their Ingredients stay Unresolved and their Recipes' Allergens unknown (fail closed), rather than carrying a guess.

## Consequences

- Changing the catalogue takes a release. A Recipe's effective Allergens are derived when it is read, so a corrected Item's Allergens apply to every Recipe at once. Which Item a line refers to is decided when the line is saved, though, so a line that was Unresolved stays so until the Recipe is edited.
- The Drop 2 review queue, where the LLM proposes tags for unknown items, needs a household table of Items alongside this list. The keys of the list stay valid there.

## Considered Options

- A household `item` table seeded by a migration: rejected for now. The seed would be frozen in a released migration, and the parser would need the catalogue read out of SQL on every call.

## Amendment: the starter catalogue (#8)

The catalogue grows to a few hundred Items, kept in its own data file (`catalogue.ts`), drafted by an AI with every Allergen reviewed by a person before release. Neither makes it exhaustive or authoritative, and the README says so to anyone deploying Mise. Because it ships in code, a fresh Household has it from the first run and every release upgrades it in place: corrected Allergens apply to stored Recipes at once, and new Items to lines imported or edited afterwards (a line saved Unresolved stays so, as above). There are no Household Items or edits yet for an upgrade to overwrite. When the Drop 2 household table arrives, its Items and edits take precedence over the shipped list, and a release only adds or corrects shipped Items.

- **Brand variance.** An Item whose brands differ only by a known Allergen or two is tagged with all of them: bottled lemon juice and dried apricots carry sulphite, chocolate chips carry milk and soy. That over-tags a few Recipes but never under-tags one. An Item that varies open-endedly (stock cubes, broth, bread, tortillas, sausages, curry paste, pesto, gnocchi) stays out and fails closed.
- **Forms.** Matching keeps words that name a form ("fresh", "roasted") on its second try, so "fresh pasta" reaches the egg pasta and not the dried. It never drops "dried": "chopped dried apricots" reaches the sulphited Item, and "dried mango", which has no Item, stays Unresolved instead of becoming fresh mango.
- **Gluten.** The Allergens name wheat but not gluten, so barley, rye and malt (pearl barley, malt vinegar, beer) stay out rather than pass a gluten-free diet. Oats are in the catalogue untagged, though they are often cross-contaminated with wheat, and so are Worcestershire sauce (malt vinegar in some recipes) and miso (barley miso exists), because Recipes lean on them. A gluten-free diet is not fully protected until an Allergen covers gluten.

## Amendment: the Household's own Items and aliases (#9)

The household table arrives with the Resolve Ingredients screen rather than in Drop 2. The Household can add Items (`item`, with `item_allergen`) and add aliases to any Item, shipped or its own (`item_alias`). Its Items are keyed `household:<row id>`, with AUTOINCREMENT so a key is never handed out twice, and they never clash with a shipped key. Matching layers them over the shipped list: where a name of the Household's reads the same as a shipped one, the Household's wins, so a release that later ships the same name doesn't take it away. A name or alias that already names another Item is refused, so the Household cannot shadow one by accident. A new Item's Allergens must be stated, even when there are none: once its lines resolve, their Recipes stop failing closed, so "none" has to be said rather than assumed.

Adding an Item or an alias resolves every Unresolved Ingredient it now matches, in every Recipe, at once. That is the point of the screen. A line saved Unresolved no longer waits for its Recipe to be edited when the Household is the one who taught Mise the name. A release that adds shipped Items still resolves only lines saved afterwards.

The parser and the Allergen derivation take the Household's catalogue as an argument (the shipped one by default), so they stay pure domain code. The Worker reads the catalogue from SQLite on each call that needs it. A restore rejects an alias or Ingredient naming an Item that neither list has.

## Amendment: editing Items, and the Store Section override (#26)

The Household can edit Items from the Items screen (`update_item`). Its own Items can change in every field: name, aliases, Store Section, unit family and Allergens. A shipped Item can gain aliases and can be kept in a Store Section of the Household's choosing, but its name, unit family and Allergens are refused (`shipped_item`). They stay corrected by release, so a release that fixes a shipped Allergen reaches every Household, and no Household is left holding an edit that hides the fix. Where a store keeps a shipped Item is up to the store, so that is the Household's to say.

The override lives in its own table (`item_section`, one row per shipped Item, keyed by the shipped key), not in a copy of the Item. Everything else about the Item still comes from the release. Choosing the section the Item ships in deletes the row, so a later release that moves the Item applies again. The catalogue applies the overrides as it is read, and a Grocery List groups its lines by the Item's section when it is read, so the override applies to every list from then on. A restore rejects an override of an Item the shipped catalogue doesn't have, and one of a Household Item, which keeps its section on its own row.

Edits apply the same way as the rest of the catalogue. A Recipe's Allergens and a Slot's Conflicts are derived when they are read, so an Allergen edit changes them on every Recipe that uses the Item and every Slot that plans one, at once. Like any Conflict that arises outside the Slot tools, a new one shows on the Week and blocks nothing (ADR 0012). Taking an Allergen away is never done by leaving it out: the edit lists every Allergen the Item now has, and an empty list is how "none" is said. The Items screen asks to confirm each Allergen taken away, and to tick "Contains none of these" when all of them go, as at creation. A name or alias an edit gives resolves the Unresolved Ingredients it now matches, as adding one does. A name or alias it takes away leaves the lines already resolved to the Item as they are: which Item a line refers to is decided when it is saved. A name or alias that already names another Item is refused.
