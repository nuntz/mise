import { expect, test } from "vitest";
import { buildId } from "../buildId";

/** A git that answers each command as given, or isn't there when `answers` is undefined. */
const git = (answers?: Record<string, string>) => (args: string[]) => answers?.[args.join(" ")];

test("in CI the build is the deployed commit, shortened", () => {
  expect(buildId("4f9c2e1a7b3d5e6f8091a2b3c4d5e6f708192a3b", git())).toBe("4f9c2e1");
});

test("a local build is the checked-out commit", () => {
  expect(buildId(undefined, git({ "rev-parse --short=7 HEAD": "a1b2c3d", "status --porcelain": "" }))).toBe("a1b2c3d");
});

test("a local build with uncommitted changes says so", () => {
  expect(
    buildId(undefined, git({ "rev-parse --short=7 HEAD": "a1b2c3d", "status --porcelain": " M apps/web/src/App.tsx" })),
  ).toBe("a1b2c3d-dirty");
});

test("without git the build is dev, not a failed build", () => {
  expect(buildId(undefined, git())).toBe("dev");
  expect(buildId("", git())).toBe("dev");
});
