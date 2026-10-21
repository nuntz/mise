# Canonical Item catalogue

Recipe ingredients, Staples, allergen tags and store sections all refer to one canonical Item record instead of free-text item names. Grocery merging (eggs across three dinners overriding the eggs Staple) and allergen safety both depend on "egg", "eggs" and "large eggs" being the same thing. Free text would make those correctness properties depend on string luck. Ingredients that match no Item stay Unresolved and fail closed for allergens.
