/**
 * Fails if a test file sits where no test command `bun run ci` runs would reach it. A test that
 * no runner reaches leaves CI green: `bun test packages scripts` once skipped every test in
 * `scripts/` (#118), as a bare argument is a filter inside bun's test root, not a folder.
 *
 *   bun run check:tests-run
 */

export interface TestSetup {
  /** `[test] root` in bunfig.toml: where `bun test` looks for files. */
  bunRoot: string;
  /** The root package.json's scripts; the check follows `ci`. */
  scripts: Record<string, string>;
  /** Each workspace's folder and `test` script, by package name. */
  workspaces: Record<string, { dir: string; test?: string }>;
}

/** What `bun test <args>` runs: under a `./path`, or under the root and matching a bare filter. */
function bunTestReaches(args: string[], bunRoot: string): (file: string) => boolean {
  const paths = args.filter((arg) => arg.startsWith("./")).map((arg) => arg.slice(2).replace(/\/$/, ""));
  const filters = args.filter((arg) => !arg.startsWith("./") && !arg.startsWith("-"));
  return (file) =>
    paths.some((path) => file.startsWith(`${path}/`)) ||
    (file.startsWith(`${bunRoot}/`) && (filters.length === 0 || filters.some((filter) => file.includes(filter))));
}

export function unrunTests(files: string[], setup: TestSetup): string[] {
  const reaches: ((file: string) => boolean)[] = [];
  const seen = new Set<string>();
  /** Follows a script's commands: `bun test`, `bun run <script>`, `bun run --filter <name> test`. */
  function follow(script: string) {
    for (const command of script.split("&&")) {
      const [tool, verb, ...args] = command.trim().split(/\s+/);
      if (tool !== "bun") continue;
      if (verb === "test") reaches.push(bunTestReaches(args, setup.bunRoot));
      if (verb !== "run") continue;
      if (args[0] === "--filter" && args[2] === "test") {
        const workspace = setup.workspaces[args[1]?.replace(/^'|'$/g, "") ?? ""];
        // Vitest's default include: every test file in the workspace.
        if (workspace?.test?.includes("vitest")) reaches.push((file) => file.startsWith(`${workspace.dir}/`));
      } else {
        const name = args[0] ?? "";
        const next = setup.scripts[name];
        if (next !== undefined && !seen.has(name)) {
          seen.add(name);
          follow(next);
        }
      }
    }
  }
  follow(setup.scripts.ci ?? "");
  return files.filter((file) => !reaches.some((reach) => reach(file)));
}

async function main() {
  const { $ } = await import("bun");
  const root = (await import("../package.json")).default as { scripts: Record<string, string>; workspaces: string[] };
  const bunfig = await Bun.file("bunfig.toml").text();
  const bunRoot = bunfig.match(/^root\s*=\s*"\.?\/?([^"]*)"/m)?.[1]?.replace(/\/$/, "") ?? ".";
  const workspaces: TestSetup["workspaces"] = {};
  for (const pattern of root.workspaces) {
    for await (const manifest of new Bun.Glob(`${pattern}/package.json`).scan(".")) {
      const { name, scripts } = (await Bun.file(manifest).json()) as { name: string; scripts?: { test?: string } };
      workspaces[name] = { dir: manifest.replace(/\/package\.json$/, ""), test: scripts?.test };
    }
  }
  const files = (await $`git ls-files -z --cached --others --exclude-standard`.text())
    .split("\0")
    .filter((file) => /\.test\.[cm]?[jt]sx?$/.test(file));
  const unrun = unrunTests(files, { bunRoot, scripts: root.scripts, workspaces });
  if (unrun.length === 0) {
    console.log(`check:tests-run: every one of ${files.length} test files runs in \`bun run ci\``);
    return;
  }
  for (const file of unrun) console.error(`${file}: no test command in \`bun run ci\` runs it`);
  console.error(
    "Move it under a folder a runner covers, or make `ci` run it (`./path` for bun test, not a bare filter).",
  );
  process.exit(1);
}

if (import.meta.main) await main();
