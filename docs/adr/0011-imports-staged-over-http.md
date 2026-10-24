# Imported files are staged over HTTP, then imported by a tool

A Paprika export is uploaded with `PUT …/imports/paprika` on the household Durable Object, which stores the file in R2 under `imports/<id>.paprikarecipes` and returns the id. The import itself is a tool, `run_paprika_import({ upload })`, which reads the file, imports it and deletes it. Like a photo (ADR 0010), an export is megabytes of binary that cannot travel in a tool call. The import, though, is a mutation with a typed result (the run log), so it stays a tool that the PWA, the agent and a coordinator all call the same way. The route only carries bytes.

`run_paprika_import` is the one tool the household runs itself rather than through the SQLite-only handler table. It has to read R2 and store photos before the transaction. Photos go to R2 first, under `photos/sha256-<hex>` so that a photo is stored once however often it is imported. Then every Recipe is upserted in a single transaction that also writes the run log. After the commit, photos that no Recipe shows any more are deleted. Since a content-addressed photo can be shared, deleting any photo now checks that no Recipe still shows it.

## Consequences

- The upload must be `application/octet-stream` (or `application/zip`), which a form on another site cannot send without a CORS preflight. Exports are limited to 100 MB. The household reads the whole file into memory and inflates it one Recipe at a time.
- An upload that is never imported, or an import that fails part-way through, leaves the file under `imports/`. A failed import can also leave the photos it stored as orphans under `photos/`, which the export lists, as with ADR 0010. The export does not list that prefix, and a later upload gets a new id, so a leftover file is harmless.
- A Recipe whose revision is unchanged is skipped before its photo is hashed, so re-importing the same file writes nothing to R2.

## Amendment: screenshots (Drop 2)

Screenshots are staged the same way: `PUT …/imports/screenshots`, one image per request, stores it under `imports/<id>.screenshot` and returns the id, and `import_screenshots({ uploads, draft? })` reads them together with the model's vision, then deletes them whatever came of it. The route takes the image as its body like a photo's (ADR 0010), but only the types the model reads (JPEG, PNG, WebP, GIF), up to 5 MB each. The tool reads at most 10 together, 20 MB in all, so that one request to the model can carry them as base64. The screenshots are not kept: the Draft holds what the model read, and the person who took them still has them.

