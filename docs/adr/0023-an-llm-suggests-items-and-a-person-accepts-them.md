# An LLM suggests Items for Unresolved Ingredients, and only a person makes them count

SPEC planned an LLM normaliser that reads every Ingredient at import. Drop 1 shipped a deterministic parser and a catalogue of Items instead (ADR 0009), so in Drop 2 the parser stays the only thing that reads a line: amount, unit, name and note. The LLM is asked only about Ingredients the parser left Unresolved. For each one it makes a Suggestion: an existing Item the name is an alias of, or a new Item with its Allergens. A Suggestion changes nothing until a person accepts it on the Resolve Ingredients screen. Until then the Ingredient stays Unresolved and its Recipe fails closed for Allergens.

An LLM's Allergens can be wrong in exactly the way that hurts: a missed sesame or a "none" that should have been milk. ADR 0009 already requires a new Item's Allergens to be stated, even when there are none, because accepting them is what stops Recipes failing closed. A model can draft that statement, but only a person can make it. The screen says the Suggestion is AI-drafted and not guaranteed complete.

## Consequences

- Re-normalising the Paprika backlog means asking for Suggestions on every Unresolved Ingredient. Parsed lines are not re-read, so the deterministic parser's results never change behind anyone's back.
- Accepting a Suggestion goes through the existing tools (`create_item`, alias, `resolve_ingredient`), so it resolves every matching line at once, like an Item added by hand.

## Considered Options

- LLM parses every line (SPEC as first written): rejected. It would replace a tested deterministic parser with one that can disagree with it from run to run.
- Auto-apply Suggestions above a confidence threshold: rejected. A confident wrong Allergen is the failure that matters.
