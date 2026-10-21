# Every Hard Constraint names an Allergen

An allergy, intolerance or diet must name an Allergen, because the Allergen is what Recipes are checked against: their Ingredients' Items carry Allergens (ADR 0001), and nothing else about a Recipe is known well enough to exclude it on. The Constraint's term is only a label ("lactose" on a milk intolerance, "gluten-free" on a wheat diet). A dislike is Soft, so it may name only a term; one that is never matched costs some scoring, not safety.

Severity is not stored: allergy, intolerance and diet are Hard and dislike is Soft, always, so it is derived from the kind (`constraintSeverity`).

## Consequences

- Conflict checks and the Proposer only ever compare Allergens for Hard Constraints, and every Hard Constraint has one to compare.
- Diets that no Allergen describes (vegetarian, halal) cannot be recorded yet. They need a property of Items alongside Allergens, added under the same human review as the catalogue.

## Considered Options

- Accept term-only Hard Constraints and ignore them in checks: rejected, because the Household would believe a Member is protected when nothing enforces it.
- Accept them and treat every Recipe as conflicting (fail closed): rejected, because the Member could then never be planned for.
