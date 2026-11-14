import { expect, test } from "bun:test";
import { changelogBetween, entriesFor, metaOf, releasesBetween, scopesOf, shortenLinks } from "./upstream-notes";

test("releasesBetween keeps the releases after `from` up to `to`, oldest first, without prereleases", () => {
  const tags = ["11.12.0", "11.12.0-alpha.1", "10.78.0", "11.11.0", "11.4.0", "11.3.0", "11.13.0"];
  expect(releasesBetween(tags, "11.4.0", "11.12.0")).toEqual(["11.11.0", "11.12.0"]);
});

test("releasesBetween reads v-prefixed tags and versions", () => {
  expect(releasesBetween(["v1.5.2", "v1.5.1", "v1.5.0", "v1.4.0"], "1.4.0", "v1.5.1")).toEqual(["v1.5.0", "v1.5.1"]);
});

test("scopesOf is the package's own name and its dependencies from the same organization", () => {
  const deps = ["@sentry/core", "magic-string", "@opentelemetry/api", "@sentry/server-utils"];
  expect([...scopesOf("@sentry/cloudflare", deps)].sort()).toEqual(["cloudflare", "core", "server-utils"]);
  expect([...scopesOf("agents", ["zod"])]).toEqual(["agents"]);
});

const SENTRY_BODY = `### Important Changes

- **ref(cloudflare): Use the shared request handler wrapper (#1)**

  Cloudflare Workers now use the same request handler wrapper.

  - Request spans now set \`client.address\`.

- **feat(nestjs): Monitor every @Cron method (#2)**

  Set \`monitorCronJobs: true\`.

### Other Changes

- fix(core): Avoid stack overflow (#3)
- fix(core, browser): Shared fix (#4)
- test(cloudflare): Port a suite (#5)
- feat(deps): bump compression (#6)
- feat!(core): Remove an option (#7)

Work in this release was contributed by someone.`;

test("entriesFor keeps an entry scoped to the package, with the prose indented under it", () => {
  const { kept, dropped } = entriesFor(SENTRY_BODY, new Set(["cloudflare", "core"])) ?? { kept: [], dropped: 0 };
  expect(kept).toEqual([
    "- **ref(cloudflare): Use the shared request handler wrapper (#1)**\n\n  Cloudflare Workers now use the same request handler wrapper.\n\n  - Request spans now set `client.address`.",
    "- fix(core): Avoid stack overflow (#3)",
    "- fix(core, browser): Shared fix (#4)",
    "- feat!(core): Remove an option (#7)",
  ]);
  // nestjs, the cloudflare test and the deps bump; the closing line is no entry.
  expect(dropped).toBe(3);
});

test("entriesFor has nothing to filter in notes without scoped entries", () => {
  expect(entriesFor("### Added\n\n- `pi update` lists each package.\n", new Set(["pi-durable"]))).toBeUndefined();
});

test("shortenLinks turns a GitHub link to an issue or pull request into its number", () => {
  expect(shortenLinks("fix ([#25851](https://github.com/getsentry/sentry-javascript/pull/25851))")).toBe(
    "fix (#25851)",
  );
  expect(shortenLinks("([#11679](https://github.com/earendil-works/pi/issues/11679))")).toBe("(#11679)");
});

test("metaOf reads the repository, its folder and the dependencies from npm's manifest, as an object or a list of one", () => {
  const manifest = {
    name: "@earendil-works/pi-schema",
    repository: { url: "git+https://github.com/earendil-works/pi.git", type: "git", directory: "packages/schema" },
  };
  const read = { repo: "earendil-works/pi", directory: "packages/schema", dependencies: [] };
  expect(metaOf(manifest)).toEqual(read);
  expect(metaOf([manifest])).toEqual(read);
  expect(
    metaOf({
      repository: "git+https://github.com/getsentry/sentry-javascript.git",
      dependencies: { "@sentry/core": "1" },
    }),
  ).toEqual({ repo: "getsentry/sentry-javascript", directory: undefined, dependencies: ["@sentry/core"] });
  expect(metaOf({ repository: "https://gitlab.com/a/b.git" }).repo).toBeUndefined();
});

const CHANGELOG = `# Changelog

## [Unreleased]

- Not out yet.

## [1.5.2] - 2026-11-10

## [1.5.1] - 2026-11-09

### Fixed

- Lost completion notifications.

## [1.5.0] - 2026-11-02

- Older.
`;

test("changelogBetween keeps the changelog's sections after `from` up to `to`, as written", () => {
  expect(changelogBetween(CHANGELOG, "1.5.0", "v1.5.2")).toBe(
    "## [1.5.2] - 2026-11-10\n\n## [1.5.1] - 2026-11-09\n\n### Fixed\n\n- Lost completion notifications.",
  );
  expect(changelogBetween("## 2.0.0\n\n- New.\n\n## 1.0.0\n\n- Old.\n", "1.0.0", "2.0.0")).toBe("## 2.0.0\n\n- New.");
  expect(changelogBetween(CHANGELOG, "1.5.2", "1.5.2")).toBe("");
});
