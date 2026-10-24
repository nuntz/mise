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
    // Dependencies load without their source maps. The pool sends a test file the modules it needs
    // in one WebSocket message, and with every dependency's map inlined, a file that imports the
    // Worker late in a run (stored-export.test.ts) went over workerd's 32 MiB limit and crashed it.
    {
      name: "no-dependency-source-maps",
      enforce: "pre",
      load(id) {
        const file = id.split("?")[0] ?? id;
        if (!file.includes("/node_modules/") || !/\.[cm]?js$/.test(file)) return null;
        return { code: readFileSync(file, "utf8"), map: { mappings: "" } };
      },
    },
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // A fictional Access team and application; identity.test.ts signs tokens for them.
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: "mise-test.cloudflareaccess.com",
          ACCESS_AUD: "test-audience",
          // `bun run check:export` points this at a downloaded export for test/stored-export.test.ts.
          ...(process.env.MISE_STORED_EXPORT && {
            STORED_EXPORT: readFileSync(process.env.MISE_STORED_EXPORT, "utf8"),
          }),
        },
      },
    }),
  ],
  test: {
    // The first Durable Object in each file loads the Worker bundle (Agents SDK, Sentry), which
    // takes several seconds on CI runners. Later tests run in milliseconds.
    testTimeout: 30_000,
  },
});
