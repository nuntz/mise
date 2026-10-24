import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Sentry from "@sentry/cloudflare";
import { Agent, callable } from "agents";
import { expect, test } from "vitest";
import { sentryOptions } from "../src/observability";

test("callable methods survive construction retry after a storage failure", async () => {
  await runInDurableObject(env.Household.getByName(crypto.randomUUID()), async (_household, state) => {
    let fail = true;
    class RecoveryAgent extends Agent<Env> {
      constructor(ctx: DurableObjectState, bindings: Env) {
        super(ctx, bindings);
        if (fail) {
          fail = false;
          throw new Error("Exceeded allowed rows read in Durable Objects free tier.");
        }
      }
      @callable()
      async read() {
        return "ready";
      }
    }
    const Wrapped = Sentry.instrumentAgentWithSentry(sentryOptions, RecoveryAgent);
    expect(() => new Wrapped(state, env)).toThrow("Exceeded allowed rows read");
    const recovered = new Wrapped(state, env);
    expect(recovered.getCallableMethods().has("read")).toBe(true);
  });
});
