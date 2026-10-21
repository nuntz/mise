import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    agents(),
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A fictional Access team and application; identity.test.ts signs tokens for them.
      miniflare: { bindings: { ACCESS_TEAM_DOMAIN: "mise-test.cloudflareaccess.com", ACCESS_AUD: "test-audience" } },
    }),
  ],
  test: {
    // The first Durable Object in each file loads the Worker bundle (Agents SDK, Sentry), which
    // takes several seconds on CI runners. Later tests run in milliseconds.
    testTimeout: 30_000,
  },
});
