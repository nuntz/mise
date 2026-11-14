import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [solid()],
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    // A failed query prints the start of the DOM, uncoloured, rather than 7,000 characters of it.
    env: { DEBUG_PRINT_LIMIT: "1500", COLORS: "false" },
  },
});
