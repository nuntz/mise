/**
 * The names a deploy relies on are written again where no import reaches: Pulumi runs infra/index.ts
 * on Node, which can't load the domain package's TypeScript, and scripts run outside the Worker.
 * These tests keep each copy in step with its source.
 */
import { expect, test } from "bun:test";
import { AGENT_LOG_PATH, DAY_SHEET_PATH } from "@mise/domain";
import wrangler from "../apps/worker/wrangler.jsonc";

/** The string a top-level `const name = "…"` in `file` holds. */
async function constIn(file: string, name: string): Promise<string | undefined> {
  const source = await Bun.file(new URL(`../${file}`, import.meta.url)).text();
  return source.match(new RegExp(`^const ${name} = "([^"]*)";$`, "m"))?.[1];
}

/** Whether `wrangler.jsonc` sends a request for `path` to the Worker before its static assets. */
function runsWorkerFirst(path: string): boolean {
  return (wrangler.assets.run_worker_first as string[]).some((pattern) =>
    pattern.endsWith("/*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern,
  );
}

test.each([
  ["DAY_SHEET_PATH", DAY_SHEET_PATH],
  ["AGENT_LOG_PATH", AGENT_LOG_PATH],
])("infra's %s is the domain package's, and the Worker answers it before the assets", async (name, path) => {
  expect(await constIn("infra/index.ts", name)).toBe(path);
  expect(runsWorkerFirst(path)).toBe(true);
});

test("infra's Worker and bucket names, and check:export's bucket, are wrangler.jsonc's", async () => {
  const bucket = wrangler.r2_buckets[0]?.bucket_name;
  expect(await constIn("infra/index.ts", "WORKER_NAME")).toBe(wrangler.name);
  expect(await constIn("infra/index.ts", "BUCKET_NAME")).toBe(bucket);
  expect(await constIn("scripts/check-export.ts", "BUCKET")).toBe(bucket);
});
