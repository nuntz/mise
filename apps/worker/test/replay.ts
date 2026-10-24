import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { type RestoreResult, replayExport } from "../src/backup";

/** Replays an export in a Durable Object emptied of everything, schema included, as a deploy would meet it. */
export function replay(exported: unknown): Promise<RestoreResult> {
  return runInDurableObject(env.Household.getByName(crypto.randomUUID()), async (_household, state) => {
    await state.storage.deleteAll();
    return replayExport(state.storage, exported);
  });
}
