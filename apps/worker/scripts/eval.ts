/**
 * Runs the real model on recorded fixtures, so that a prompt or model change can be checked by hand:
 * Suggestions for Unresolved names, and recipes read from pasted text, recorded pages, TikTok captions
 * and screenshots. It calls a model and costs money, so it never runs in CI (CODING_STANDARDS.md).
 *
 *   ANTHROPIC_API_KEY=… bun run eval
 *
 * Prints each name and text with what the model answered, and exits non-zero if any falls short of
 * the fixture's expectation.
 */

import { readFileSync } from "node:fs";
import {
  type Allergen,
  type Course,
  type ItemId,
  type ReadRecipeRequest,
  type RecipeReading,
  readRecipePage,
  SHIPPED_ITEMS,
  type SuggestedItem,
  suggestItems,
} from "@mise/domain";
import pasted from "../../../fixtures/eval/pasted-recipes.json";
import recorded from "../../../fixtures/eval/recipe-pages.json";
import screenshotSets from "../../../fixtures/eval/screenshots.json";
import captions from "../../../fixtures/eval/tiktok-captions.json";
import fixture from "../../../fixtures/eval/unresolved-names.json";
import { openLlm } from "../src/llm";

type Expectation = { item?: string; allergens?: string[]; notFood?: boolean };

type ReadingExpectation = {
  isRecipe: boolean;
  title?: string;
  ingredients?: string[];
  servings?: number;
  minutes?: number;
  course?: Course;
};

if (process.env.CI) {
  console.error("bun run eval calls a real model, and CI never does.");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY to run the eval.");
  process.exit(1);
}

const llm = openLlm({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY });
const suggested = new Map<string, SuggestedItem>();
for await (const batch of suggestItems(
  llm,
  fixture.names.map((entry) => entry.name),
  SHIPPED_ITEMS,
)) {
  for (const answer of batch.answers) suggested.set(answer.name, answer.suggested);
}

let misses = 0;
for (const { name, expect } of fixture.names as { name: string; expect: Expectation }[]) {
  const answer = suggested.get(name);
  const problem = shortfall(expect, answer);
  if (problem) misses++;
  console.log(`${problem ? "✗" : "✓"} ${name}: ${describe(answer)}${problem ? `  (${problem})` : ""}`);
}
console.log(`\n${fixture.names.length - misses} of ${fixture.names.length} as expected.\n`);

const fixtures = `${import.meta.dir}/../../../fixtures`;
// A page is read as an import reads it: its text, for the model.
const pages = recorded.pages.map(({ name, page, expect }) => ({
  name,
  text: readRecipePage(readFileSync(`${fixtures}/pages/${page}`, "utf8"), "https://example.com/").text,
  expect,
}));
// A TikTok is read by its oEmbed caption, as an import reads it.
const tiktoks = captions.captions.map(({ name, oembed, expect }) => ({
  name,
  text: (JSON.parse(readFileSync(`${fixtures}/oembed/${oembed}`, "utf8")) as { title: string }).title,
  expect,
}));
const sources: { name: string; request: ReadRecipeRequest; expect: ReadingExpectation }[] = [
  ...([...pasted.texts, ...pages, ...tiktoks] as { name: string; text: string; expect: ReadingExpectation }[]).map(
    ({ name, text, expect }) => ({ name, request: { text }, expect }),
  ),
  ...screenshotSets.sets.map(({ name, screenshots, expect }) => ({
    name,
    request: {
      images: screenshots.map((file) => ({
        bytes: new Uint8Array(readFileSync(`${fixtures}/screenshots/${file}`)),
        type: "image/png" as const,
      })),
    },
    expect: expect as ReadingExpectation,
  })),
];
let readingMisses = 0;
for (const { name, request, expect } of sources) {
  const reading = await llm.readRecipe(request);
  const problems = readingShortfalls(expect, reading);
  if (problems.length > 0) readingMisses++;
  console.log(`${problems.length > 0 ? "✗" : "✓"} ${name}: ${JSON.stringify(reading)}`);
  for (const problem of problems) console.log(`    ${problem}`);
}
console.log(`\n${sources.length - readingMisses} of ${sources.length} read as expected.`);
process.exit(misses + readingMisses > 0 ? 1 : 0);

/** What the reading lacks against the expectation. */
function readingShortfalls(expect: ReadingExpectation, reading: RecipeReading): string[] {
  if (!reading.isRecipe) return expect.isRecipe ? ["expected a recipe"] : [];
  if (!expect.isRecipe) return ["expected no recipe"];
  const problems: string[] = [];
  if (expect.title && !reading.title.toLowerCase().includes(expect.title.toLowerCase())) {
    problems.push(`expected a title with "${expect.title}"`);
  }
  for (const line of expect.ingredients ?? []) {
    if (!reading.ingredients.includes(line)) problems.push(`expected the line "${line}" as written`);
  }
  for (const key of ["servings", "minutes", "course"] as const) {
    if (expect[key] !== undefined && reading[key] !== expect[key]) problems.push(`expected ${key} ${expect[key]}`);
  }
  return problems;
}

/** What the answer lacks against the expectation, or null if nothing. */
function shortfall(expect: Expectation, answer: SuggestedItem | undefined): string | null {
  if (expect.notFood) return answer ? "expected no Suggestion" : null;
  if (!answer) return "no Suggestion";
  if (expect.item) return answer.kind === "existing" && answer.item === expect.item ? null : `expected ${expect.item}`;
  const missing = (expect.allergens ?? []).filter((allergen) => !allergensOf(answer).includes(allergen as Allergen));
  return missing.length > 0 ? `missing ${missing.join(", ")}` : null;
}

function allergensOf(answer: SuggestedItem): Allergen[] {
  return answer.kind === "new" ? answer.allergens : (SHIPPED_ITEMS.item(answer.item as ItemId)?.allergens ?? []);
}

function describe(answer: SuggestedItem | undefined): string {
  if (!answer) return "no Suggestion";
  if (answer.kind === "existing") return `another name for ${answer.item}`;
  return `new Item "${answer.name}" (${answer.section}, ${answer.unitFamily}) with ${answer.allergens.join(", ") || "no Allergens"}`;
}
