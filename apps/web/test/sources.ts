import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dirname, "../src");

/** Source text without its comments, so a name in a comment never counts as a use. */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

/** Each web source file under src (components and modules, `messages.ts` aside), without comments. */
export const sources: { file: string; code: string }[] = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts") && file !== "messages.ts")
  .map((file) => ({ file, code: withoutComments(readFileSync(join(srcDir, file), "utf8")) }));

/**
 * The text of every string and template literal in `code`, each kind found on its own, so a string inside
 * a template's placeholder, such as `${t("recipe.photoAlt")}`, is found too.
 */
export function literals(code: string): string[] {
  return [/"((?:[^"\\\n]|\\.)*)"/g, /'((?:[^'\\\n]|\\.)*)'/g, /`((?:[^`\\]|\\.)*)`/g].flatMap((quoted) =>
    [...code.matchAll(quoted)].map(([, text]) => text ?? ""),
  );
}
