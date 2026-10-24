import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { replay } from "./replay";

// `bun run check:export` hands this the deployed Household's latest nightly export; otherwise it is skipped.
test.skipIf(env.STORED_EXPORT === undefined)(
  "the deployed Household's latest export reads back under this code",
  async () => {
    expect(await replay(JSON.parse(env.STORED_EXPORT ?? ""))).toEqual({ ok: true });
  },
);
