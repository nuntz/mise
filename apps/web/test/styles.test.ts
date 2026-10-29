import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

/** The component styles, without their comments. */
const appCss = readFileSync(join(import.meta.dirname, "../src/styles/app.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Each web component's path under src and its source. */
const srcDir = join(import.meta.dirname, "../src");
const components = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => ({ file, source: readFileSync(join(srcDir, file), "utf8") }));

/** Every match of `pattern` in the web components, as "file: match". */
function inComponents(pattern: RegExp): string[] {
  return components.flatMap(({ file, source }) => [...source.matchAll(pattern)].map(([match]) => `${file}: ${match}`));
}

test("type sizes come from the tokens, never a pixel size in the component styles", () => {
  const pixelType = appCss.match(/(?:^|[;{\s])(?:font|font-size|line-height)\s*:[^;}]*\d+(?:\.\d+)?px[^;}]*/g) ?? [];
  expect(pixelType.map((declaration) => declaration.trim())).toEqual([]);
  expect(
    inComponents(/["']?(?:font|font-size|fontSize|line-height|lineHeight)["']?\s*:\s*["']?[^"';,}]*\d+(?:\.\d+)?px/g),
  ).toEqual([]);
});

test("colours come from the tokens, never a hex colour in the component styles", () => {
  expect(appCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
});

test("every alert in the web components is a banner, so no error reads as body text", () => {
  expect(
    inComponents(/<[a-z]+\b[^>]*\brole="alert"[^>]*>/g).filter((tag) => !/\bclass="[^"]*\bbanner\b/.test(tag)),
  ).toEqual([]);
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
  expect(inComponents(/<(?:ul|ol)\b[^>]*>/g).filter((tag) => !/\bclass=/.test(tag))).toEqual([]);
});

test("a file input is only ever Mise's file picker, never the browser's", () => {
  expect(inComponents(/type="file"/g).filter((match) => !match.startsWith("FilePicker.tsx"))).toEqual([]);
});

test("a checkbox is drawn from the tokens, never the browser's", () => {
  expect(declarations('input[type="checkbox"]')).toMatch(/appearance:\s*none/);
});

const tokensCss = readFileSync(join(import.meta.dirname, "../src/styles/tokens.css"), "utf8");

/** The hex colour tokens set in the first rule for `selector` in tokens.css, by name. */
function colours(selector: string): Record<string, string> {
  const block = tokensCss.match(new RegExp(`${selector.replace(/[[\]]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
  return Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6,8})\s*;/g)].map(([, name, hex]) => [name, hex]),
  );
}

/** The colour tokens in daylight and in the kitchen theme, which overrides daylight's. */
const daylight = colours(":root");
const themes = { daylight, kitchen: { ...daylight, ...colours('[data-theme="kitchen"]') } };

type Rgb = [number, number, number];

/** A hex colour token as sRGB channels 0–255 and its alpha 0–1; fails the test if the token isn't a hex. */
function parseHex(hex: string | undefined): { rgb: Rgb; alpha: number } {
  expect(hex).toMatch(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
  const [r, g, b, a] = [1, 3, 5, 7].map((i) => Number.parseInt(hex?.slice(i, i + 2) || "ff", 16));
  return { rgb: [r ?? 0, g ?? 0, b ?? 0], alpha: (a ?? 255) / 255 };
}

/** WCAG relative luminance. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `hex` laid over an opaque `under`, as a browser blends them. */
function over(hex: string | undefined, under: Rgb): Rgb {
  const { rgb, alpha } = parseHex(hex);
  const [r, g, b] = rgb.map((c, i) => alpha * c + (1 - alpha) * under[i as 0 | 1 | 2]);
  return [r ?? 0, g ?? 0, b ?? 0];
}

/** The two extremes a photo under a translucent scrim can be. */
const photos: Rgb[] = [
  [255, 255, 255],
  [0, 0, 0],
];

test.each(Object.entries(themes))("on-photo text reads at 4.5:1 on the scrim over any photo, %s", (_, theme) => {
  for (const photo of photos) {
    expect(contrast(parseHex(theme["on-photo"]).rgb, over(theme.scrim, photo))).toBeGreaterThanOrEqual(4.5);
  }
});

test("in kitchen mode the scrim stands off the page at 3:1 over any photo, so a Leftovers band shows", () => {
  const surface = parseHex(themes.kitchen.surface).rgb;
  for (const photo of photos) {
    expect(contrast(over(themes.kitchen.scrim, photo), surface)).toBeGreaterThanOrEqual(3);
  }
});
