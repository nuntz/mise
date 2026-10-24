/**
 * Fails if this code cannot read the deployed Household: replays its latest nightly export from R2
 * through the migrations and the domain parsers, as the deploy is about to (see `replayExport`).
 * Run by the deploy job before anything ships; locally it needs the same Cloudflare credentials.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun run check:export
 *
 * The export holds the family's data, so it stays in a temporary file that is removed afterwards,
 * and only the result is printed: CI logs are public.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

/** Must match the R2 `bucket_name` in apps/worker/wrangler.jsonc. */
const BUCKET = "mise";
/** Exports are named by the Household's local date (`exportKey`), which can be a day either side of UTC. */
const DAYS_BACK = 2;

const dir = await mkdtemp(join(tmpdir(), "mise-export-"));
let exitCode = 0;
try {
  exitCode = await check(join(dir, "export.json"));
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.exit(exitCode);

async function check(file: string): Promise<number> {
  const date = await downloadLatest(file);
  if (date === null) {
    // A first deploy has no export yet. Anything else (a token without R2 access) is worth a look.
    console.log("::warning::No recent nightly export; the stored Household was not checked.");
    return 0;
  }
  console.log(`Replaying the export of ${date}.`);
  const result = await $`bunx vitest run test/stored-export.test.ts`
    .cwd("apps/worker")
    .env({ ...process.env, MISE_STORED_EXPORT: file })
    .nothrow();
  return result.exitCode;
}

/** Downloads the newest export into `file`, returning its date, or null when there is none. */
async function downloadLatest(file: string): Promise<string | null> {
  for (let daysBack = -1; daysBack <= DAYS_BACK; daysBack++) {
    const date = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
    const got = await $`bunx wrangler r2 object get ${BUCKET}/exports/${date}.json --remote --file ${file}`
      .cwd("apps/worker")
      .quiet()
      .nothrow();
    if (got.exitCode === 0) return date;
  }
  return null;
}
