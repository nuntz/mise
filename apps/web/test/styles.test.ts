import { readdirSync, readFileSync } from "node:fs";
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

test("h2, h3 and h4 are three heading roles: section head, overline and body at 600", () => {
  expect(declarations("h2")).toMatch(/font:\s*var\(--type-title-sm\)/);
  expect(declarations("h3")).toMatch(/font:\s*var\(--type-label\)/);
  expect(declarations("h3")).toMatch(/text-transform:\s*uppercase/);
  expect(declarations("h4")).toMatch(/font:\s*var\(--type-body\)/);
  expect(declarations("h4")).toMatch(/font-weight:\s*600/);
});

test("a sheet's title takes the header's remaining width, so the close button sits at the right edge", () => {
  expect(declarations(".sheet-header .page-heading")).toMatch(/flex:\s*1/);
});

test("no list renders the browser's markers", () => {
  expect(declarations("ul, ol")).toMatch(/list-style:\s*none/);
  expect(appCss).not.toMatch(/list-style:\s*(?!none)[a-z]/);
});

test("every list in the web components is classed, so none falls back to the browser's look", () => {
  const sources = join(import.meta.dirname, "../src");
  const unclassed = readdirSync(sources, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx"))
    .flatMap((file) =>
      [...readFileSync(join(sources, file), "utf8").matchAll(/<(?:ul|ol)\b[^>]*>/g)]
        .filter(([tag]) => !/\bclass=/.test(tag))
        .map(([tag]) => `${file}: ${tag}`),
    );
  expect(unclassed).toEqual([]);
});
