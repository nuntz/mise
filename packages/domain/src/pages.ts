import { contentHash, FALLBACK_SERVINGS, ImportedRecipe, importedFromReading } from "./imports";
import type { RecipeReading } from "./llm";
import { courseOf, cuisineOf, mainProteinOf, servingsOf } from "./paprika";

/**
 * What Mise reads of a recipe page: where it lives, its title and photo, and its Recipe when the
 * page gives one as schema.org JSON-LD.
 */
export type RecipePage = {
  /** The page's canonical URL: imports upsert on it. */
  url: string;
  /** The page's title, for a link-only Draft. */
  title: string | null;
  /** The absolute URL of the Recipe's photo, else of the page's `og:image`. */
  image: string | null;
  /** The schema.org Recipe, mapped; null when the page has none Mise can use. */
  recipe: ImportedRecipe | null;
  /**
   * The page's readable text, one block per line, for the model to read when it has no Recipe:
   * its article (or main part) when it marks one, else its body, without scripts or navigation.
   */
  text: string;
};

/** The longest page text the model is given: as much as pasted text may be. */
const MAX_PAGE_TEXT = 20_000;

/** Reads a fetched page; `pageUrl` is where it was fetched from, after redirects. */
export function readRecipePage(html: string, pageUrl: string): RecipePage {
  const head = headOf(html, pageUrl);
  const url = trusted(head.canonical, pageUrl) ?? normaliseUrl(pageUrl);
  const structured = findRecipe(jsonLdOf(html));
  const image = (structured && imageOf(structured.image, url)) ?? head.image;
  const recipe = structured && mapRecipe(structured, url, image);
  return { url, title: textOf(structured?.name).slice(0, 200) || head.title, image, recipe, text: pageText(html) };
}

/**
 * The page's canonical URL, unless it can't be this page's: on another site, or the site's home,
 * as some sites name for every page. Trusting that would make every Recipe of the site one.
 */
function trusted(canonical: string | null, pageUrl: string): string | null {
  if (!canonical) return null;
  const site = (url: URL) => url.hostname.replace(/^www\./, "");
  const named = new URL(canonical);
  return site(named) === site(new URL(pageUrl)) && named.pathname !== "/" ? canonical : null;
}

/** The revision of a page the model reads: its text, so that an unchanged page is not read again. */
export function pageRevision(page: RecipePage): string {
  return `page:${contentHash(page.text)}`;
}

/** The Draft the model read from a page without a schema.org Recipe; the page itself is a tap away. */
export function importedFromPage(
  page: RecipePage,
  reading: Extract<RecipeReading, { isRecipe: true }>,
): ImportedRecipe {
  return importedFromReading(reading, {
    externalId: page.url,
    revision: pageRevision(page),
    notes: null,
    url: page.url,
  });
}

/**
 * A link-only Draft of `url`: no Ingredients or steps, only a title (the page's, else one made of
 * the link) until someone adds the recipe's text. `revision` says what was read of it, so that
 * importing the link again updates it only when there is more to read.
 */
export function linkOnlyRecipe(url: string, title: string | null, revision: string): ImportedRecipe {
  return ImportedRecipe.parse({
    externalId: url,
    revision,
    title: (title || titleFromUrl(url)).slice(0, 200),
    baseServings: FALLBACK_SERVINGS,
    ingredients: [],
    steps: [],
    tags: [],
    effortMinutes: null,
    cuisine: null,
    mainProtein: null,
    course: null,
    notes: null,
    url,
    author: null,
    importedPreference: null,
    inTrash: false,
  });
}

/** A title made of a link: its last path segment in words ("red-lentil-dal" → "Red lentil dal"), else its host. */
function titleFromUrl(url: string): string {
  const parsed = new URL(url);
  const segment = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  let words = segment;
  try {
    words = decodeURIComponent(segment);
  } catch {}
  words = words
    .replace(/\.[a-z]+$/i, "")
    .replace(/[-_+]+/g, " ")
    .replace(/^\d+\s+/, "")
    .trim();
  if (!/[a-z]/i.test(words)) return parsed.hostname;
  return words[0]?.toUpperCase() + words.slice(1);
}

/**
 * A URL as an id: without its fragment and the tracking parameters a share adds, so that the
 * same page shared twice is one Recipe.
 */
export function normaliseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  const tracking: string[] = [];
  parsed.searchParams.forEach((_, key) => {
    if (/^utm_|^(fbclid|gclid|igshid|mc_cid|mc_eid)$/i.test(key)) tracking.push(key);
  });
  for (const key of tracking) parsed.searchParams.delete(key);
  return parsed.toString();
}

type Head = { canonical: string | null; title: string | null; image: string | null };

/** The canonical URL, title and `og:image` of the page, from its tags. */
function headOf(html: string, pageUrl: string): Head {
  const meta = new Map<string, string>();
  let canonical: string | null = null;
  for (const [tag, name] of html.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const attributes = attributesOf(tag);
    if (name?.toLowerCase() === "link") {
      if (attributes.get("rel")?.toLowerCase().split(/\s+/).includes("canonical")) {
        canonical ??= absoluteUrl(attributes.get("href"), pageUrl);
      }
      continue;
    }
    const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    const content = attributes.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decodeHtml(content).trim());
  }
  canonical ??= absoluteUrl(meta.get("og:url"), pageUrl);
  const title = meta.get("og:title") || textOf(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  return {
    canonical: canonical && normaliseUrl(canonical),
    title: title || null,
    image: absoluteUrl(meta.get("og:image:secure_url") ?? meta.get("og:image"), pageUrl),
  };
}

function attributesOf(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  for (const [, name, double, single, bare] of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    if (name) attributes.set(name.toLowerCase(), double ?? single ?? bare ?? "");
  }
  return attributes;
}

/** An http(s) URL, resolved against the page; null for anything else. */
function absoluteUrl(value: string | undefined | null, base: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(decodeHtml(value).trim(), base);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Every JSON-LD block of the page that parses; one with a raw line break or tab in a string is read too. */
function jsonLdOf(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/application\/ld\+json/i.test(attributes ?? "") || body === undefined) continue;
    for (const text of [body, body.replace(/[\r\n\t]+/g, " ")]) {
      try {
        blocks.push(JSON.parse(text));
        break;
      } catch {}
    }
  }
  return blocks;
}

type Node = Record<string, unknown>;

/** The first node typed as a Recipe, wherever it sits: at the top, in an array or a `@graph`, or nested. */
function findRecipe(value: unknown, depth = 0): Node | null {
  if (depth > 8 || typeof value !== "object" || value === null) return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findRecipe(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const node = value as Node;
  const types = [node["@type"]].flat();
  if (types.some((type) => typeof type === "string" && /(^|[/:])Recipe$/.test(type))) return node;
  for (const child of Object.values(node)) {
    const found = findRecipe(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/** A schema.org Recipe as Mise's; null when it has no name or no Ingredients, to be read some other way. */
function mapRecipe(node: Node, url: string, image: string | null): ImportedRecipe | null {
  const categories = strings(node.recipeCategory);
  const cuisines = strings(node.recipeCuisine);
  const keywords = strings(node.keywords);
  const ingredients = strings(node.recipeIngredient ?? node.ingredients, false);
  if (ingredients.length === 0) return null;
  const fields = {
    externalId: url,
    title: textOf(node.name).slice(0, 200),
    baseServings: servingsOf(strings(node.recipeYield).join(" ")),
    ingredients: ingredients.slice(0, 200).map((line) => line.slice(0, 500)),
    steps: stepsOf(node.recipeInstructions)
      .slice(0, 100)
      .map((step) => step.slice(0, 5000)),
    tags: [...categories, ...cuisines].slice(0, 30).map((tag) => tag.slice(0, 50)),
    effortMinutes: effortOf(node),
    cuisine: cuisineOf([...cuisines, ...categories]),
    mainProtein: mainProteinOf([...categories, ...keywords]),
    course: courseOf(categories),
    notes: textOf(node.description).slice(0, 20_000) || null,
    url,
    author: authorOf(node.author),
    importedPreference: null,
    inTrash: false,
  };
  // The Recipe's own fields and photo, not the whole node: its ratings and dates change without the Recipe changing.
  const revision = `ld:${contentHash(JSON.stringify({ ...fields, image }))}`;
  const recipe = ImportedRecipe.safeParse({ ...fields, revision });
  return recipe.success ? recipe.data : null;
}

/**
 * Text values: a string, a number, or a list of them; `split` reads a comma-separated string
 * ("Dessert, Baking") as several.
 */
function strings(value: unknown, split = true): string[] {
  return [value]
    .flat()
    .flatMap((entry) => (typeof entry === "string" || typeof entry === "number" ? [String(entry)] : []))
    .flatMap((entry) => (split ? entry.split(",") : [entry]))
    .map(textOf)
    .filter(Boolean);
}

/** Steps as text, from a string, a list of strings, HowToSteps, or HowToSections of them. */
function stepsOf(value: unknown): string[] {
  if (typeof value === "string") return linesOf(value);
  if (Array.isArray(value)) return value.flatMap(stepsOf);
  if (typeof value !== "object" || value === null) return [];
  const node = value as Node;
  if (node.itemListElement !== undefined) return stepsOf(node.itemListElement);
  return stepsOf(node.text ?? node.name);
}

/** totalTime; else prepTime plus cookTime, as far as they are known; else unknown. */
function effortOf(node: Node): number | null {
  const total = minutesOf(node.totalTime);
  const parts = [minutesOf(node.prepTime), minutesOf(node.cookTime)].filter((part) => part !== null);
  const minutes = total ?? (parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : null);
  return minutes !== null && minutes <= 24 * 60 ? minutes : null;
}

/** An ISO 8601 duration ("PT1H30M", "P0DT45M") in whole minutes. */
function minutesOf(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:[\d.]+S)?)?$/i.exec(value.trim());
  if (!match || value.trim().length < 3) return null;
  const [, days, hours, minutes] = match.map((part) => Number(part ?? 0));
  return (days ?? 0) * 24 * 60 + (hours ?? 0) * 60 + (minutes ?? 0);
}

function authorOf(value: unknown): string | null {
  const [first] = [value].flat();
  const name = typeof first === "object" && first !== null ? (first as Node).name : first;
  return textOf(name).slice(0, 200) || null;
}

function imageOf(value: unknown, base: string): string | null {
  const [first] = [value].flat();
  const url = typeof first === "object" && first !== null ? (first as Node).url : first;
  return typeof url === "string" ? absoluteUrl(url, base) : null;
}

/** Elements whose content is never the recipe; a page's header and footer are not, outside its article. */
const NEVER_TEXT = ["script", "style", "noscript", "template", "svg", "nav", "aside", "form"];
const PAGE_FURNITURE = ["header", "footer"];

function pageText(html: string): string {
  const page = withoutElements(html.replace(/<!--[\s\S]*?-->/g, ""), NEVER_TEXT);
  const part = /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(page) ?? /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(page);
  const text = part?.[1] ?? withoutElements(/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(page)?.[1] ?? page, PAGE_FURNITURE);
  return linesOf(text).join("\n").slice(0, MAX_PAGE_TEXT);
}

function withoutElements(html: string, elements: string[]): string {
  return elements.reduce(
    (rest, element) => rest.replace(new RegExp(`<${element}\\b[\\s\\S]*?</${element}\\s*>`, "gi"), ""),
    html,
  );
}

/** HTML as lines of text: tags dropped, block ends as line breaks. */
function linesOf(html: string): string[] {
  return decodeHtml(
    html
      .replace(/<\/?(p|div|li|br|h\d|ol|ul|tr|section|article|main|table|blockquote|figure)\b[^>]*>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .split(/\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** A value as one line of text, its tags dropped and entities decoded. */
function textOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeHtml(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  deg: "°",
  times: "×",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  frac13: "⅓",
  frac23: "⅔",
  frac18: "⅛",
};

function decodeHtml(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]\w*);/gi, (entity, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}
