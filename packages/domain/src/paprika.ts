import { z } from "zod";
import { contentHash, FALLBACK_SERVINGS, ImportedRecipe } from "./imports";
import { normaliseItemName } from "./items";
import type { Course, ImportedPreference } from "./recipes";
import { decompress, readZip } from "./zip";

/** The image types a photo may be, recognised from its first bytes. */
export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif";

export type ImportedPhoto = { bytes: Uint8Array; type: ImageType };

/** One file of an export: a mapped Recipe, or why it could not be read. */
export type PaprikaEntry =
  | {
      entry: string;
      ok: true;
      recipe: ImportedRecipe;
      photo: ImportedPhoto | null;
      /** Why a photo the entry has could not be used; the Recipe is imported without it. */
      photoError: string | null;
    }
  | { entry: string; ok: false; error: string };

/**
 * The Recipes in a `.paprikarecipes` file (a zip of gzipped JSON, one file per Recipe), read one
 * at a time; null when the file is not a zip at all.
 */
export function readPaprikaExport(file: Uint8Array<ArrayBuffer>): AsyncIterable<PaprikaEntry> | null {
  const entries = readZip(file);
  if (!entries) return null;
  return (async function* () {
    for (const { name, read } of entries) {
      if (name.endsWith("/")) continue;
      let text: string;
      try {
        const bytes = await read();
        // Gzipped as Paprika writes them; plain JSON is read too.
        const json = bytes[0] === 0x1f && bytes[1] === 0x8b ? await decompress(bytes, "gzip") : bytes;
        text = new TextDecoder().decode(json);
      } catch {
        yield { entry: name, ok: false, error: "The file could not be unpacked" };
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        yield { entry: name, ok: false, error: "The file is not JSON" };
        continue;
      }
      yield { entry: name, ...mapPaprikaRecipe(json, `content:${contentHash(text)}`) };
    }
  })();
}

/** A Paprika Recipe: a JSON object whose fields can each be missing or of another type. */
const PaprikaRecipe = z.record(z.string(), z.unknown());

type Mapped = Omit<Extract<PaprikaEntry, { ok: true }>, "entry"> | Omit<Extract<PaprikaEntry, { ok: false }>, "entry">;

function mapPaprikaRecipe(json: unknown, fallbackRevision: string): Mapped {
  const read = PaprikaRecipe.safeParse(json);
  if (!read.success) return { ok: false, error: "The file is not a Paprika Recipe" };
  const paprika = read.data;
  const title = text(paprika.name);
  if (!title) return { ok: false, error: "The Recipe has no name" };
  const externalId = text(paprika.uid);
  if (!externalId) return { ok: false, error: `${title} has no uid` };

  const categories = list(paprika.categories);
  const notes = [text(paprika.description), text(paprika.notes)].filter(Boolean).join("\n\n");
  const recipe = ImportedRecipe.safeParse({
    externalId,
    revision: text(paprika.hash) || fallbackRevision,
    title,
    baseServings: servingsOf(text(paprika.servings)),
    ingredients: lines(paprika.ingredients),
    steps: lines(paprika.directions),
    tags: categories,
    effortMinutes: effortOf(paprika),
    cuisine: cuisineOf(categories),
    mainProtein: mainProteinOf(categories),
    course: courseOf(categories),
    notes: notes || null,
    url: text(paprika.source_url) || null,
    author: text(paprika.source) || null,
    importedPreference: preferenceOf(paprika.rating, paprika.on_favorites),
    inTrash: flag(paprika.in_trash),
  });
  if (!recipe.success) {
    const issue = recipe.error.issues[0];
    return { ok: false, error: `${title}: ${issue?.path.join(".")} ${issue?.message}` };
  }
  const photo = photoOf(largePhotoData(paprika) ?? paprika.photo_data);
  return {
    ok: true,
    recipe: recipe.data,
    photo: "error" in photo ? null : photo.photo,
    photoError: "error" in photo ? photo.error : null,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function lines(value: unknown): string[] {
  return text(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Category names, as the export writes them; an object with a name is read for its name. */
function list(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((category) => text(typeof category === "object" && category !== null ? category.name : category))
    .filter(Boolean);
}

/** True for `true` and 1, which older exports write. */
function flag(value: unknown): boolean {
  return value === true || value === 1;
}

/** The first whole number in the text ("Serves 4–6" → 4, "Makes 12 muffins" → 12). */
export function servingsOf(servings: string): number {
  const first = /\d+/.exec(servings);
  const count = first ? Number(first[0]) : 0;
  return count >= 1 && count <= 100 ? count : FALLBACK_SERVINGS;
}

/** The total time; else prep plus cook, as far as they are known; else unknown. */
function effortOf(paprika: z.infer<typeof PaprikaRecipe>): number | null {
  const total = minutesOf(text(paprika.total_time));
  if (total !== null) return total;
  const parts = [minutesOf(text(paprika.prep_time)), minutesOf(text(paprika.cook_time))].filter((m) => m !== null);
  if (parts.length === 0) return null;
  const sum = parts.reduce((a, b) => a + b, 0);
  return sum <= 24 * 60 ? sum : null;
}

const DURATION_UNITS: [RegExp, number][] = [
  [/^d(?:ays?)?$/, 24 * 60],
  [/^h(?:(?:ou)?rs?)?$/, 60],
  [/^m(?:in(?:ute)?s?)?$/, 1],
];
const HALVES: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75 };

/**
 * Minutes in a duration as people write it: "1 hr 30 mins", "1h30", "45 minutes", "1 ½ hours",
 * "1:30", "90", "PT1H30M". A range counts as its upper end. Null when unreadable, zero, or more
 * than a day (marinating overnight is not cooking effort).
 */
function minutesOf(duration: string): number | null {
  const lower = duration.toLowerCase().trim();
  let minutes: number | null = null;
  const clock = /^(\d+):([0-5]\d)$/.exec(lower);
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  else if (/^\d+$/.test(lower)) minutes = Number(lower);
  else {
    const iso = lower.replace(/^pt/, "");
    const parts = iso.matchAll(/(\d+(?:[.,]\d+)?)?\s*([½¼¾])?\s*([a-z]+)/g);
    let sum = 0;
    let found = false;
    for (const [, number, half, word] of parts) {
      const value = Number((number ?? "0").replace(",", ".")) + (half ? (HALVES[half] as number) : 0);
      const unit = DURATION_UNITS.find(([pattern]) => pattern.test(word as string));
      if (!unit || value === 0) continue;
      sum += value * unit[1];
      found = true;
    }
    // "1h30": minutes after the hours, without their unit.
    const trailing = /h(?:(?:ou)?rs?)?\s*(\d+)$/.exec(lower);
    if (found && trailing) sum += Number(trailing[1]);
    if (found) minutes = Math.round(sum);
  }
  return minutes !== null && minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}

/** 4–5 stars or a favourite is positive, 1–2 stars negative; 3 stars or unrated says nothing. */
function preferenceOf(rating: unknown, favourite: unknown): ImportedPreference | null {
  const stars = Number(rating);
  if (flag(favourite) || stars >= 4) return "positive";
  if (stars >= 1 && stars <= 2) return "negative";
  return null;
}

/** Category names that say a Recipe's cuisine, read as `normaliseItemName` reads them. */
const CUISINES = synonyms({
  american: ["american", "southern", "bbq"],
  british: ["british", "english"],
  canadian: ["canadian"],
  caribbean: ["caribbean", "jamaican"],
  chinese: ["chinese", "cantonese", "sichuan", "szechuan"],
  ethiopian: ["ethiopian"],
  french: ["french"],
  german: ["german"],
  greek: ["greek"],
  indian: ["indian"],
  italian: ["italian"],
  japanese: ["japanese"],
  korean: ["korean"],
  lebanese: ["lebanese"],
  mediterranean: ["mediterranean"],
  mexican: ["mexican", "tex-mex", "tex mex"],
  "middle eastern": ["middle eastern", "middle-eastern"],
  moroccan: ["moroccan"],
  persian: ["persian", "iranian"],
  spanish: ["spanish"],
  thai: ["thai"],
  turkish: ["turkish"],
  vietnamese: ["vietnamese"],
});

/** Category names that say a Recipe's main protein. */
const PROTEINS = synonyms({
  beef: ["beef", "steak", "ground beef"],
  chicken: ["chicken", "chicken breast", "chicken thigh"],
  chickpeas: ["chickpeas", "garbanzo"],
  egg: ["egg", "eggs"],
  fish: ["fish", "salmon", "tuna", "cod", "halibut"],
  lamb: ["lamb"],
  lentils: ["lentils", "dal", "dhal"],
  pork: ["pork", "bacon", "ham"],
  seafood: ["seafood", "shellfish", "shrimp", "prawns", "mussels"],
  tofu: ["tofu", "tempeh"],
  turkey: ["turkey"],
  beans: ["beans", "legumes"],
});

/**
 * Category names that say a Recipe's Course. Only categories are read, never the title or
 * Ingredients: a wrong guess would keep a dinner out of every Proposal (ADR 0022).
 */
/**
 * Only categories that rarely hold a dinner: "Baking" (lasagna, pot pie), "Sauces" (bolognese)
 * and "Brunch" (shakshuka) are left out, so they leave the Course unknown and a candidate.
 */
const COURSE_CATEGORIES = synonyms<Course>({
  main: ["main", "mains", "main course", "main dish", "dinner", "dinners", "weeknight"],
  side: ["side", "sides", "side dish", "side dishes", "condiment", "condiments", "dip", "dips"],
  dessert: ["dessert", "desserts"],
  drink: ["drink", "drinks", "beverage", "beverages", "cocktail", "cocktails"],
  breakfast: ["breakfast"],
  snack: ["snack", "snacks", "appetizer", "appetizers", "starter", "starters"],
});

/**
 * Main if any category names a main; otherwise the Course every category with a synonym agrees
 * on; otherwise unknown. A wrong Course keeps a dinner out of every Proposal, so doubt leaves it
 * unknown (ADR 0022).
 */
export function courseOf(categories: string[]): Course | null {
  const courses = new Set(categories.flatMap((category) => COURSE_CATEGORIES.get(normaliseItemName(category)) ?? []));
  if (courses.has("main")) return "main";
  return courses.size === 1 ? ([...courses][0] as Course) : null;
}

function synonyms<T extends string>(table: Record<T, string[]>): Map<string, T> {
  const map = new Map<string, T>();
  for (const [value, names] of Object.entries(table) as [T, string[]][]) {
    for (const name of names) map.set(normaliseItemName(name), value);
  }
  return map;
}

/** The cuisine the first category naming one says. */
export function cuisineOf(categories: string[]): string | null {
  return firstSynonym(categories, CUISINES);
}

/** The main protein the first category naming one says. */
export function mainProteinOf(categories: string[]): string | null {
  return firstSynonym(categories, PROTEINS);
}

/** The value the first category with a synonym stands for. */
function firstSynonym<T extends string>(categories: string[], table: Map<string, T>): T | null {
  for (const category of categories) {
    const value = table.get(normaliseItemName(category));
    if (value) return value;
  }
  return null;
}

/**
 * The full-size photo's data. `photo_data` is only a thumbnail (280 px in a real export); the
 * full photo is the entry of `photos` whose filename `photo_large` names.
 */
function largePhotoData(paprika: z.infer<typeof PaprikaRecipe>): unknown {
  const filename = text(paprika.photo_large);
  if (!filename || !Array.isArray(paprika.photos)) return undefined;
  const large = paprika.photos.find((photo) => typeof photo === "object" && photo?.filename === filename);
  return large?.data;
}

function photoOf(data: unknown): { photo: ImportedPhoto | null } | { error: string } {
  if (typeof data !== "string" || data.trim() === "") return { photo: null };
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(data.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return { error: "The photo is not valid base64" };
  }
  const type = imageType(bytes);
  return type ? { photo: { bytes, type } } : { error: "The photo is not a JPEG, PNG, WebP, GIF or AVIF image" };
}

/** Recognises an image from its first bytes. */
export function imageType(bytes: Uint8Array): ImageType | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "image/png";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(8, 12))) return "image/avif";
  return null;
}
