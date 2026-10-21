# Fixtures

Clearly fictional sample data, shared by tests and local development. Nothing here describes a real household.

- `sample-household.json`: input for `setup_household`, with three Members: Sam, a child who never signs in, and Robin, who signs in as the local `DEV_CALLER_EMAIL` (`cook@example.com`). Seeds a local `wrangler dev` deployment (`bun run seed`) and the worker tests.
