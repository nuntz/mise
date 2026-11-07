import { expect, test } from "bun:test";
import { type TestSetup, unrunTests } from "./check-tests-run";

const SETUP: TestSetup = {
  bunRoot: "packages",
  scripts: {
    ci: "bun run lint && bun test packages ./scripts && bun run test:web",
    "test:web": "bun run --filter @mise/web test",
  },
  workspaces: {
    "@mise/web": { dir: "apps/web", test: "vitest run" },
    "@mise/worker": { dir: "apps/worker", test: "vitest run" },
  },
};

test("a bare filter only reaches files under bun's test root, as `bun test scripts` did in #118", () => {
  const setup = { ...SETUP, scripts: { ...SETUP.scripts, ci: "bun test packages scripts" } };

  expect(unrunTests(["packages/domain/a.test.ts", "scripts/b.test.ts"], setup)).toEqual(["scripts/b.test.ts"]);
});

test("a workspace's Vitest suite counts once `ci` reaches its test script", () => {
  const files = ["apps/web/test/a.test.tsx", "apps/worker/test/b.test.ts", "scripts/c.test.ts"];

  // ci runs test:web, which runs @mise/web's tests; nothing runs @mise/worker's.
  expect(unrunTests(files, SETUP)).toEqual(["apps/worker/test/b.test.ts"]);
});

test("a test outside every runner's folders is reported", () => {
  expect(unrunTests(["infra/a.test.ts", "fixtures/b.test.ts"], SETUP)).toEqual([
    "infra/a.test.ts",
    "fixtures/b.test.ts",
  ]);
});
