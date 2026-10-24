# A Recipe's Course is worked out at import and corrected by hand; the Proposer fills dinners only with mains or Recipes of unknown Course

The Proposer used to treat every Recipe as a dinner candidate. A lemonade imported from Paprika's "Drinks" could be proposed for dinner, and with no effort time it passed every Effort Budget too. So each Recipe now has a Course (`main`, `side`, `dessert`, `drink`, `breakfast`, `snack`, or null for unknown). It says what the dish is served as, which is not the same as a Slot's meal: pancakes are breakfast whichever meal they are eaten at.

The import works the Course out from Paprika's categories through the `COURSE_CATEGORIES` synonym table ("Desserts" is dessert, "Drinks" a drink, "Dinner" and "Weeknight" a main, and so on). If any category names a main, the Course is main. Otherwise, if every category the table knows names the same Course, it is that one. Otherwise, and when no category is in the table, it is null. It never guesses from the title or the Ingredients. A wrong guess would keep a real dinner out of every Proposal, and "Lemon chicken" is not a drink. So the principle is that doubt leaves the Course unknown, and an unknown Course stays a candidate: the table leaves out categories that commonly hold mains, such as "Baking" (lasagna, pot pie, quiche), "Sauces" (bolognese, ragù) and "Brunch" (shakshuka, frittata), and two categories that disagree, "Desserts" and "Drinks", leave it null too.

The Proposer excludes a Recipe whose Course is set and is not `main`, and keeps one whose Course is null. It is a hard rule like the Effort Budget, not a score penalty, and it holds for Recurring Recipes too, since a Slot's Recipe is what the dinner is. `Exclusions` counts these Recipes as `course`, checked after `never` and before `recent`, so a dinner left unplanned can say how many were ruled out for not being a main dish. The rule depends only on the Recipe, so a Proposal stays fixed by its seed (ADR 0013).

Correcting a Course by hand is the repair path. The Recipe form has a Course picker, and the next Proposal goes by the new Course, with no re-import. A hand correction is an edit in Mise, so a later import flags the Recipe for a merge and does not overwrite it. An import still updates the Course of a Recipe nobody edited, when its categories change in Paprika.

## Consequences

- Recipes typed into Mise, and those imported before the Course existed, have a null Course and are proposed as before. A migration adds the column, and the backup carries it like any other column (ADR 0006).
- Reasons stored before the Course existed have no `course` count. They read it as 0.
- Only dinners are proposed, so the Course matters only there for now. Once the Proposer fills other meals, it is the Course that says what fits them, not the Slot's meal alone.
- A dessert or drink can still be put in a dinner Slot by hand. The rule only binds what the Proposer chooses, so it does not fill the next dinner with the Leftovers of one Locked there.

## Amendment: Draft Recipes (Drop 2)

A Recipe the LLM read (a page without JSON-LD, a video's caption, a screenshot, pasted text) lands as a Draft Recipe, and the LLM fills in its Course along with the rest. That is a guess from the title and the Ingredients, which this ADR otherwise rules out, but a Draft is never proposed until a person accepts it, and accepting it shows the Course to correct. The guess is reviewed before it can keep a dinner out of a Proposal. Recipes imported from structured data (Paprika, JSON-LD) still work their Course out from categories only.
