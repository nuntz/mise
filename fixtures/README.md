# Fixtures

Clearly fictional sample data, shared by tests and local development. Nothing here describes a real household.

- `sample-household.json`: input for `setup_household`, with three Members: Sam, a child who never signs in, and Robin, who signs in as the local `DEV_CALLER_EMAIL` (`cook@example.com`). Seeds a local `wrangler dev` deployment (`bun run seed`) and the worker tests.
- `sample.paprikarecipes`: a Paprika export of five fictional Recipes (one with a photo, one in Paprika's trash, one filed under Drinks), for the import tests. It is built from `paprika.ts` by `bun scripts/paprika-fixture.ts`, so edit the Recipes there and rerun the script. `paprika.ts` also builds variants of an export inside tests.
- `eval/unresolved-names.json`: Unresolved Ingredient texts with what a good Suggestion holds, for `bun run eval`, which asks the real model by hand (never in CI).
- `eval/pasted-recipes.json`: pasted texts (a caption, a message, a caption with no recipe) with what a good reading holds, for the same `bun run eval`.
- `pages/`: fictional recipe pages, shaped like real sites' (a Yoast `@graph`, a top-level JSON-LD array, a blog post with no JSON-LD), for the link import's tests.
- `eval/recipe-pages.json`: which of those pages `bun run eval` has the real model read, with what a good reading holds.
- `oembed/`: fictional answers from TikTok's oEmbed, for the TikTok import's tests: two shaped as TikTok documents them (a caption with a recipe, a caption that says "recipe in bio"), and `tiktok-uncaptioned.json` shaped as its live answers are today, with no caption, author or thumbnail.
- `eval/tiktok-captions.json`: which of those captions `bun run eval` has the real model read, with what a good reading holds.
- `screenshots/`: fictional screenshots of a recipe spread over two screens, rendered with ImageMagick.
- `eval/screenshots.json`: sets of those screenshots `bun run eval` has the real model read together, with what a good reading holds.
