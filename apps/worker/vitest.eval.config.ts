import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * The agent eval: Worker tests that call the real model (see eval/), so never in CI
 * (CODING_STANDARDS.md). Run by hand with `bun run eval:agent`, whenever the agent's prompt changes.
 * `MISE_EVAL_MODEL=<Anthropic model id>` runs it on another model than the agent's.
 */
if (process.env.CI) throw new Error("The agent eval calls a real model, and CI never does.");

declare module "vitest" {
  interface ProvidedContext {
    /** The Anthropic model to run the agent on, or "" for the agent's own. */
    agentModel: string;
  }
}

export default mergeConfig(
  base,
  defineConfig({
    test: { include: ["eval/**/*.eval.ts"], provide: { agentModel: process.env.MISE_EVAL_MODEL ?? "" } },
  }),
);
