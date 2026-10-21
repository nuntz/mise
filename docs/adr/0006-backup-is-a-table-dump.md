# The backup is a deterministic dump of every domain table

The nightly export (and `GET /agents/household/household/export`) dumps every table in the household Durable Object's SQLite except SQLite, Cloudflare, Agents SDK (`cf_`), Pi harness (`pi_`) and bookkeeping (`schema_version`, `revision`) tables. It does not go through the tools. Rows keep their column names and insertion order, plus the R2 keys under `photos/`. The file carries no timestamp (the R2 key `exports/<Household-local date>.json` names the day), so the same data always gives the same bytes. That is what lets the round-trip test assert export → restore → export is identical.

A new domain table is backed up without touching the export code. The test pinning the exported table list fails when a table appears, and that is the prompt to check it belongs.

## Consequences

- Restore (`POST …/restore`) only loads into an empty household at the same schema version. Migrating an old export means restoring it with the release that wrote it, then upgrading.
- Photos stay in R2. The export records their keys; copying the bucket is a separate step.
- The change revision is not exported; a restore sets it to 1 and notifies every topic. Clients only use it to order change notices.
