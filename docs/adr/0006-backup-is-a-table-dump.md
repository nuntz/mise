# The Backup is a deterministic dump of every domain table

The nightly Backup (and `GET /agents/household/household/export`) dumps every table in the household Durable Object's SQLite except SQLite, Cloudflare, Agents SDK (`cf_`), Pi harness (`pi_`) and bookkeeping (`schema_version`, `revision`) tables. It does not go through the tools. Rows keep their column names and insertion order. The Backup also carries the household tables' `sqlite_sequence` counters, so that an AUTOINCREMENT id (a removed Member's, say) is never handed out again after a restore, plus the R2 keys under `photos/`. The file carries no timestamp (the R2 key `exports/<Household-local date>.json` names the day), so the same data always gives the same bytes. That is what lets the round-trip test assert export → restore → export is identical.

A new domain table is backed up without touching the export code. The test pinning the exported table list fails when a table appears, and that is the prompt to check it belongs, and to add its reader to `parseStoredHousehold` so that restore validates its rows.

## Retention

After writing tonight's Backup, the household keeps the newest 30 nightly Backups and the earliest one of every month, and deletes the rest. Retention counts Backups, not days, so if the nightly Backup stops, nothing is deleted, where an R2 lifecycle rule by age would keep expiring them until none were left. The monthly Backups cover a loss nobody notices for weeks. R2 lifecycle rules cannot express "earliest of the month", so the household prunes, not the bucket. Only keys shaped `exports/<date>.json` are pruned; a file put under `exports/` by hand stays.

## Consequences

- Restore (`POST …/restore`) only loads into an empty household at the same schema version. Before committing, it reads the household back through the domain parsers the tools use; rows they cannot read (an unknown timezone, a malformed Constraint) roll the whole restore back as `invalid_export`, so the household stays empty and a corrected Backup can still be loaded. Migrating an old Backup means restoring it with the release that wrote it, then upgrading.
- Photos stay in R2. The Backup records their keys; copying the bucket is a separate step.
- The change revision is not exported; a restore sets it to 1 and notifies every topic. Clients only use it to order change notices.
- Pruning runs only after a Backup is written. A failed prune is reported to Sentry and does not fail the Backup; the next night catches it up.
- The monthly Backups are kept forever, about 20 MB a year at current size. Thinning them out is a later decision.
