import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

/**
 * The agent eval: Worker tests that call the real model (see eval/), so never in CI
 * (CODING_STANDARDS.md). Run by hand with `bun run eval:agent`, whenever the agent's prompt changes.
 */
if (process.env.CI) throw new Error("The agent eval calls a real model, and CI never does.");

export default mergeConfig(base, defineConfig({ test: { include: ["eval/**/*.eval.ts"] } }));
