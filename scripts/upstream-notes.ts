/**
 * Prints what changed in a dependency between two versions, for the coding standard "An upgrade
 * accounts for what upstream changed": first the package's own `CHANGELOG.md` sections, when npm
 * names the package's folder in a monorepo (Pi's packages: their changes are there, not in the
 * release notes), then the GitHub release notes. In a monorepo's notes it keeps only the entries
 * scoped to the package or to its dependencies from the same organization (`fix(cloudflare): …`,
 * `fix(core): …` for `@sentry/cloudflare`), with the prose indented under them, and drops test,
 * chore and CI entries. A release whose notes have no scoped entries, like Pi's, prints whole.
 * GitHub is read over REST only, so it works where its GraphQL API is blocked.
 *
 *   bun run upstream-notes <package> <from> <to>    (after `from`, up to and including `to`)
 */
import { $ } from "bun";

type Version = [number, number, number];

/** A release's version, from a tag such as `11.12.0`, `v1.5.0` or `@scope/name@1.2.3`; none for a prerelease. */
function versionOf(tag: string): Version | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compare(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The tags after `from` up to and including `to`, oldest first. */
export function releasesBetween(tags: string[], from: string, to: string): string[] {
  const low = versionOf(from);
  const high = versionOf(to);
  if (!low || !high) throw new Error(`Not a version: ${low ? to : from}`);
  return tags
    .map((tag) => ({ tag, version: versionOf(tag) }))
    .filter((release): release is { tag: string; version: Version } => release.version !== undefined)
    .filter(({ version }) => compare(version, low) > 0 && compare(version, high) <= 0)
    .sort((a, b) => compare(a.version, b.version))
    .map(({ tag }) => tag);
}

/** The scopes a monorepo's notes use for the package: its own name, and its organization's packages it depends on. */
export function scopesOf(pkg: string, dependencies: string[]): Set<string> {
  const organization = pkg.startsWith("@") ? pkg.slice(0, pkg.indexOf("/") + 1) : undefined;
  const scopes = new Set([pkg.slice(pkg.indexOf("/") + 1)]);
  if (organization)
    for (const dependency of dependencies)
      if (dependency.startsWith(organization)) scopes.add(dependency.slice(organization.length));
  return scopes;
}

/** Entry types that change nothing a user of the package sees. */
const NOISE = new Set(["test", "chore", "ci", "build", "docs", "style"]);
const SCOPED = /^- (?:\*\*)?([a-z]+)!?\(([^)]*)\)!?:/;

/**
 * The entries of a release's notes that concern the package. An entry is a top-level bullet and
 * the indented lines under it. Undefined when the notes have no scoped entries to filter by.
 */
export function entriesFor(body: string, scopes: Set<string>): { kept: string[]; dropped: number } | undefined {
  const entries: string[][] = [];
  let current: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("- ")) {
      current = [line];
      entries.push(current);
    } else if (current && (line.trim() === "" || /^\s/.test(line))) current.push(line);
    else current = undefined;
  }
  if (!entries.some(([first]) => SCOPED.test(first ?? ""))) return undefined;
  const kept = entries
    .filter(([first]) => {
      const match = SCOPED.exec(first ?? "");
      if (!match?.[1] || match[2] === undefined || NOISE.has(match[1])) return false;
      return match[2].split(/,\s*/).some((scope) => scopes.has(scope));
    })
    .map((lines) => lines.join("\n").trimEnd());
  return { kept, dropped: entries.length - kept.length };
}

/** Where npm's manifest of one version says the package lives; npm answers an object or a list of one. */
export function metaOf(viewed: unknown): { repo?: string; directory?: string; dependencies: string[] } {
  type Manifest = {
    repository?: { url?: string; directory?: string } | string;
    dependencies?: Record<string, string>;
  };
  const manifest: Manifest = (Array.isArray(viewed) ? viewed[0] : viewed) ?? {};
  const repository = manifest.repository;
  const url = typeof repository === "string" ? repository : repository?.url;
  return {
    repo: /github\.com[/:]([^/]+\/[^/#]+?)(?:\.git)?$/.exec(url ?? "")?.[1],
    directory: typeof repository === "string" ? undefined : repository?.directory,
    dependencies: Object.keys(manifest.dependencies ?? {}),
  };
}

/** A changelog's `## [1.5.2] - …` or `## 1.5.2` sections after `from` up to and including `to`, as written. */
export function changelogBetween(text: string, from: string, to: string): string {
  const low = versionOf(from);
  const high = versionOf(to);
  if (!low || !high) throw new Error(`Not a version: ${low ? to : from}`);
  const kept: string[] = [];
  let keeping = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      const version = versionOf(/^## \[?v?(\d+\.\d+\.\d+)\]?/.exec(line)?.[1] ?? "");
      keeping = version !== undefined && compare(version, low) > 0 && compare(version, high) <= 0;
    }
    if (keeping) kept.push(line);
  }
  return kept.join("\n").trim();
}

/** `[#123](https://github.com/…/pull/123)` → `#123`: the number is enough to look it up. */
export function shortenLinks(text: string): string {
  return text.replace(/\[#(\d+)\]\(https:\/\/github\.com\/[^)\s]+\/(?:pull|issues)\/\d+\)/g, "#$1");
}

if (import.meta.main) {
  const [pkg, from, to] = process.argv.slice(2);
  if (!pkg || !from || !to) {
    console.error("Usage: bun run upstream-notes <package> <from> <to>");
    process.exit(2);
  }
  const spec = `${pkg}@${to.replace(/^v/, "")}`;
  const view = await $`npm view ${spec} --json`.quiet().nothrow();
  if (view.exitCode !== 0) {
    console.error(`npm has no ${spec}.`);
    process.exit(2);
  }
  const { repo, directory, dependencies } = metaOf(view.json());
  if (!repo) {
    console.error(`${pkg} names no GitHub repository: read its changelog instead.`);
    process.exit(2);
  }
  const listed = (
    await $`gh api repos/${repo}/releases --paginate --jq ${".[] | select(.draft | not) | .tag_name"}`.text()
  )
    .split("\n")
    .filter(Boolean);
  const tags = releasesBetween(listed, from, to);
  const scopes = scopesOf(pkg, dependencies);

  console.log(`${pkg} ${from} → ${to}: ${repo}, ${tags.length} release${tags.length === 1 ? "" : "s"}`);
  const oldest = listed
    .map(versionOf)
    .filter((version) => version !== undefined)
    .sort(compare)[0];
  const low = versionOf(from);
  if (oldest && low && compare(oldest, low) > 0)
    console.log(`The listed releases start after ${from}: releases older than ${oldest.join(".")} are missing.`);
  console.log(`Scoped entries kept for: ${[...scopes].sort().join(", ")}\n`);

  const newest = tags.at(-1);
  if (directory && newest) {
    const path = `${directory}/CHANGELOG.md`;
    const file =
      await $`gh api ${`repos/${repo}/contents/${path}?ref=${newest}`} -H ${"Accept: application/vnd.github.raw"}`
        .quiet()
        .nothrow();
    const sections = file.exitCode === 0 ? changelogBetween(file.text(), from, to) : "";
    console.log(
      `## ${path} at ${newest}\n\n${sections ? shortenLinks(sections) : "(no file or no sections for these versions)"}\n`,
    );
  }

  for (const tag of tags) {
    const body = (await $`gh api repos/${repo}/releases/tags/${tag} --jq .body`.text()).trim();
    const entries = entriesFor(body, scopes);
    if (!entries) {
      console.log(`## ${tag} (whole notes: no scoped entries)\n\n${shortenLinks(body)}\n`);
      continue;
    }
    console.log(`## ${tag} (${entries.kept.length} kept, ${entries.dropped} dropped)\n`);
    for (const entry of entries.kept) console.log(shortenLinks(entry));
    console.log();
  }
}
