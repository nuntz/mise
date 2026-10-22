# The Item catalogue ships in code

The canonical Items (ADR 0001) are a hand-curated list in `packages/domain` (`items.ts`), not rows in the household database. The ingredient parser is pure domain code and matches against that list directly, so it runs the same in `bun test`, the Worker and the PWA. An Item's key is stable like an Allergen's: Ingredients store it, so a key is never renamed or removed, and a restore rejects an Ingredient naming a key the catalogue doesn't have.

Only Items whose Allergens are dependable whatever the brand go in. Things that vary (bread, stock cubes, sausages, curry paste) stay out, so their Ingredients stay Unresolved and their Recipes' Allergens unknown (fail closed), rather than carrying a guess.

## Consequences

- Changing the catalogue takes a release. A Recipe's effective Allergens are derived when it is read, so a corrected Item's Allergens apply to every Recipe at once. Which Item a line refers to is decided when the line is saved, though, so a line that was Unresolved stays so until the Recipe is edited.
- The Drop 2 review queue, where the LLM proposes tags for unknown items, needs a household table of Items alongside this list. The keys of the list stay valid there.

## Considered Options

- A household `item` table seeded by a migration: rejected for now. The seed would be frozen in a released migration, and the parser would need the catalogue read out of SQL on every call.
