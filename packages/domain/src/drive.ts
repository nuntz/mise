import { ImportedRecipe, importedFromReading } from "./imports";
import type { RecipeReading } from "./llm";
import { courseOf, cuisineOf, type ImportedPhoto, imageType, mainProteinOf } from "./paprika";
import { readZip } from "./zip";

/** The Household-local time the Drive folder is synced every night, after the nightly export. */
export const DRIVE_SYNC_TIME = "04:00";

/** An image in Markdown, inline (`![alt](url)`) or by reference (`![alt][image1]`). */
const IMAGE = /!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/g;
/** A reference's definition, as Drive writes one for each image: `[image1]: <data:image/png;base64,…>`. */
const DEFINITION = /^\s*\[[^\]]+\]:\s*\S.*$/;

/**
 * A Google Doc's text for the model, from its Markdown export: without its images, which Drive
 * writes as data URIs, megabytes the model has no use for. `hasImage` when it holds one, so that
 * its first image can be had for the Recipe's photo.
 */
export function docText(markdown: string): { text: string; hasImage: boolean } {
  let hasImage = false;
  const lines: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (DEFINITION.test(line)) continue;
    const without = line.replace(IMAGE, () => {
      hasImage = true;
      return "";
    });
    // A line that held only images goes, rather than leaving a blank line behind.
    if (without.trim() === "" && line.trim() !== "") continue;
    if (without.trim() === "" && lines.at(-1)?.trim() === "") continue;
    lines.push(without.trimEnd());
  }
  return { text: lines.join("\n").trim(), hasImage };
}

/**
 * The first image a Doc shows, from its zipped HTML export (the page, and its images under
 * `images/`): the first `<img>` in the page, since the zip lists the images in no particular order.
 * Null when it shows none Mise can use, or the export is not a zip.
 */
export async function firstDocImage(exported: Uint8Array<ArrayBuffer>): Promise<ImportedPhoto | null> {
  const entries = readZip(exported);
  const page = entries?.find((entry) => entry.name.toLowerCase().endsWith(".html"));
  if (!entries || !page) return null;
  const html = new TextDecoder().decode(await page.read());
  const src = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["']/i.exec(html)?.[1]?.replaceAll("&amp;", "&");
  const image = src && entries.find((entry) => entry.name === src || entry.name === decoded(src));
  if (!image) return null;
  const bytes = await image.read();
  const type = imageType(bytes);
  return type ? { bytes, type } : null;
}

/**
 * A Google Doc in the Drive folder: its id, name and when it last changed, and the names of the
 * subfolders it is filed in, outermost first (none when it sits in the folder itself).
 */
export type DriveDoc = { id: string; name: string; modifiedTime: string; folders: string[] };

/** Where a Doc opens in Google Docs. */
export function docLink(id: string): string {
  return `https://docs.google.com/document/d/${encodeURIComponent(id)}/edit`;
}

/**
 * The Draft Recipe a Doc the model read makes, upserted on the Doc's id at its modified time, so an
 * unchanged Doc is skipped. Its subfolders are its tags, and say its cuisine, main protein and Course
 * as Paprika's categories do; a folder that names a Course wins over the model's guess.
 */
export function importedFromDoc(doc: DriveDoc, reading: Extract<RecipeReading, { isRecipe: true }>): ImportedRecipe {
  const imported = importedFromReading(reading, {
    externalId: doc.id,
    revision: doc.modifiedTime,
    notes: null,
    url: docLink(doc.id),
  });
  return ImportedRecipe.parse({
    ...imported,
    tags: doc.folders.slice(0, 30).map((folder) => folder.slice(0, 50)),
    cuisine: cuisineOf(doc.folders),
    mainProtein: mainProteinOf(doc.folders),
    course: courseOf(doc.folders) ?? imported.course,
  });
}

/** A URI-encoded path as written, or as it was before being encoded when it reads as one. */
function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
