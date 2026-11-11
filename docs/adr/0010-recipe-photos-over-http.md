# Recipe photos travel over HTTP, beside the tools

A Recipe photo is uploaded, replaced and removed with `PUT` and `DELETE …/recipes/<id>/photo` on the household Durable Object, and served by `GET` on the same path, rather than through `callTool` (ADR 0002). Photos are megabytes of binary. Tool calls are JSON over the WebSocket, where they would need base64 and run into message size limits. The image goes to R2 under `photos/`; the Recipe keeps only its key (`photoKey`), which every tool returns.

This is an exception to "tools are the API" (SPEC.md §2), and was the only one until uploaded imports joined it (ADR 0011). It is kept narrow: the routes carry nothing but the image, they bump the revision and send a `recipes` change notice like any tool, and `delete_recipe` deletes the photo once the deletion is committed. The agent never needs to upload bytes, so it loses nothing.

## Consequences

- `PUT` and `DELETE` are not simple requests, so another site cannot send them without a CORS preflight, which the household refuses. Only JPEG, PNG, WebP, GIF and AVIF up to 10 MB are accepted.
- A new photo gets a new key, so its URL changes and caches never show the old one. The old object is deleted after the new key is committed.
- So a photo's URL, which names its key in `v`, is cached as `immutable` for a year: a browser asks the household for each photo about once. A URL naming no key, or an old one, gets the current photo with `no-cache`, and a matching `If-None-Match` gets a 304 without reading the photo from R2.
- An upload that fails after the object is stored can leave an orphan in R2. The export lists every key under `photos/` (ADR 0006), so orphans are visible and harmless.
