import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import agents from "agents/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    agents(),
    // Binary fixtures (`.paprikarecipes`) import as their bytes; see test/fixtures.d.ts.
    {
      name: "binary-fixtures",
      load(id) {
        if (!id.endsWith(".paprikarecipes")) return null;
        const base64 = readFileSync(id).toString("base64");
        return `export default Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));`;
      },
    },
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
