import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** The component styles, without their comments. */
const appCss = readFileSync(join(import.meta.dirname, "../src/styles/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

test("type sizes come from the tokens, never a pixel size in the component styles", () => {
  const pixelType = appCss.match(/(?:^|[;{\s])(?:font|font-size|line-height)\s*:[^;}]*\d+(?:\.\d+)?px[^;}]*/g) ?? [];
  expect(pixelType.map((declaration) => declaration.trim())).toEqual([]);
});
