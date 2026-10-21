import agents from "agents/vite";
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [agents(), solid()],
  server: {
    // `bun run dev` in apps/web talks to a `wrangler dev` running on its default port.
    proxy: { "/agents": { target: "http://localhost:8787", ws: true } },
  },
});
