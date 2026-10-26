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

/** The declarations of the rule whose selector list is exactly `selector`. */
function declarations(selector: string): string {
  const rule = [...appCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
    ([, selectors]) => selectors?.replace(/\s+/g, " ").trim() === selector,
  );
  return rule?.[2] ?? "";
}

test("a bare button takes the row look, so it never reads as disabled", () => {
  expect(declarations("button, .button")).toMatch(/border:\s*var\(--hairline\) solid var\(--line-control\)/);
  expect(declarations('button:disabled, button[aria-disabled="true"]')).toMatch(
    /border:\s*var\(--hairline\) dashed var\(--line-control\)/,
  );
  expect(declarations('button:disabled, button[aria-disabled="true"]')).toMatch(/background:\s*transparent/);
});

test("a danger button is a hairline and text in warn", () => {
  expect(declarations(".button-danger")).toMatch(/border-color:\s*var\(--warn\)/);
  expect(declarations(".button-danger")).toMatch(/color:\s*var\(--warn\)/);
});
