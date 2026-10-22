# Fixtures

Clearly fictional sample data, shared by tests and local development. Nothing here describes a real household.

- `sample-household.json`: input for `setup_household`, with three Members: Sam, a child who never signs in, and Robin, who signs in as the local `DEV_CALLER_EMAIL` (`cook@example.com`). Seeds a local `wrangler dev` deployment (`bun run seed`) and the worker tests.
- `sample.paprikarecipes`: a Paprika export of four fictional Recipes (one with a photo, one in Paprika's trash), for the import tests. It is built from `paprika.ts` by `bun scripts/paprika-fixture.ts`, so edit the Recipes there and rerun the script. `paprika.ts` also builds variants of an export inside tests.
