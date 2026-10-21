import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [agents(), cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // The first Durable Object in each file loads the Worker bundle (Agents SDK, Sentry), which
    // takes several seconds on CI runners. Later tests run in milliseconds.
    testTimeout: 30_000,
  },
});
