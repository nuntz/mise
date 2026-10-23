import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import agents from "agents/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [agents(), solid(), serviceWorker()],
  server: {
    // `bun run dev` in apps/web talks to a `wrangler dev` running on its default port.
    proxy: { "/agents": { target: "http://localhost:8787", ws: true } },
  },
});

/**
 * Emits `sw.js` from `serviceWorker.js`, with the app shell to cache: the page, every file the build
 * emits and every file in `public`. Its version changes with any of them, so a deploy replaces the cache.
 */
function serviceWorker(): Plugin {
  const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  const publicFiles = (dir: string, prefix = ""): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? publicFiles(`${dir}/${entry.name}`, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    );

  return {
    name: "mise-service-worker",
    apply: "build",
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).filter((file) => file !== "index.html");
      // The page is cached as "/": Cloudflare's asset handling redirects /index.html there.
      const shell = ["/", ...[...emitted, ...publicFiles(here("public"))].map((file) => `/${file}`)].sort();
      const version = createHash("sha256");
      for (const file of Object.values(bundle)) {
        version.update(file.type === "chunk" ? file.code : file.source);
      }
      for (const file of publicFiles(here("public"))) version.update(readFileSync(here(`public/${file}`)));
      const source = readFileSync(here("serviceWorker.js"), "utf8")
        .replace("self.__SHELL__", JSON.stringify(shell))
        .replace("self.__VERSION__", JSON.stringify(version.digest("hex").slice(0, 16)));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}
