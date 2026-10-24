import { z } from "zod";
import type { ScreenshotType } from "./imports";
import { COURSES, Course } from "./recipes";
import { SuggestedItem, type SuggestionAnswer, type SuggestionRequest } from "./suggestions";

/** An image the model reads: a screenshot, its bytes and type. */
export type RecipeImage = { bytes: Uint8Array; type: ScreenshotType };

/**
 * What the model is asked to read as a recipe: text (a caption, a message, a page, a Doc), or
 * screenshots read together, in order.
 */
export type ReadRecipeRequest = { text: string } | { images: RecipeImage[] };

/**
 * What the model read: a recipe, or the answer that the source holds none. Only what a person can
 * check at a glance: the Ingredient lines stay as the source wrote them, never parsed by the model
 * (ADR 0023). `parseIngredient` reads them, as it reads every other line.
 */
export const RecipeReading = z.discriminatedUnion("isRecipe", [
  z.object({ isRecipe: z.literal(false) }).strict(),
  z
    .object({
      isRecipe: z.literal(true),
      title: z.string().trim().min(1),
      ingredients: z.array(z.string()),
      steps: z.array(z.string()),
      /** Null when the source doesn't say. */
      servings: z.number().int().positive().nullable(),
      /** Cooking time in minutes; null when the source doesn't say. */
      minutes: z.number().int().nonnegative().nullable(),
      /** The model's guess (ADR 0022 amendment); null when it can't tell. */
      course: Course.nullable(),
    })
    .strict(),
]);
export type RecipeReading = z.infer<typeof RecipeReading>;

/**
 * A reading as a model gives it: loose, so that a stray value is dropped rather than failing the
 * read. Described for the model, as its tool's parameters.
 */
export const ModelReading = z.object({
  isRecipe: z.boolean().describe("Whether the text holds a recipe someone could cook from"),
  title: z.string().optional().describe("The dish's name"),
  ingredients: z
    .array(z.string())
    .optional()
    .describe("Each ingredient line exactly as written, amount and all; never rewritten or converted"),
  steps: z.array(z.string()).optional().describe("Each step as written, in order"),
  servings: z.number().nullable().optional().describe("How many it serves, if the text says"),
  minutes: z.number().nullable().optional().describe("Total cooking time in minutes, if the text says"),
  course: z
    .enum(COURSES)
    .nullable()
    .optional()
    .describe("What the dish is served as, from its title and ingredients; null if unsure"),
});

/**
 * A model's answer as a RecipeReading, a number out of range read as unknown; null when it can't be
 * read (not a reading, or a recipe with no title). Both adapters read answers through it.
 */
export function recipeReadingOf(answer: unknown): RecipeReading | null {
  const loose = ModelReading.safeParse(answer);
  if (!loose.success) return null;
  if (!loose.data.isRecipe) return { isRecipe: false };
  const whole = (value: number | null | undefined, least: number) =>
    value != null && Number.isInteger(value) && value >= least ? value : null;
  const reading = RecipeReading.safeParse({
    isRecipe: true,
    title: loose.data.title ?? "",
    ingredients: loose.data.ingredients ?? [],
    steps: loose.data.steps ?? [],
    servings: whole(loose.data.servings, 1),
    minutes: whole(loose.data.minutes, 0),
    course: loose.data.course ?? null,
  });
  return reading.success ? reading.data : null;
}

/**
 * The LLM behind Mise (ADR 0023). Tests use `FakeLlm`; only `bun run eval` calls a real model.
 */
export type Llm = {
  /** One request. A name the model has no answer for is left out. Throws `LlmError` if the model fails. */
  makeSuggestions(request: SuggestionRequest): Promise<SuggestionAnswer[]>;
  /** Reads a recipe from its source. Throws `LlmError` if the model fails or its answer can't be read. */
  readRecipe(request: ReadRecipeRequest): Promise<RecipeReading>;
};

/** The model could not be reached, or answered with something that could not be read. */
export class LlmError extends Error {
  constructor(detail: string, task = "make Suggestions") {
    super(`The model could not ${task}: ${detail}`);
  }
}

/**
 * An `Llm` that answers from a table of names, and reads every source as `reading`, given as a model
 * would give it, for tests. Like the real one, it leaves out names it has no answer for, and answers
 * it cannot read; it reads `reading` through `recipeReadingOf`, throwing `LlmError` when that can't;
 * and it throws while `failing`. `answer` replaces the table, to give answers the real model might
 * (for names not asked about, say).
 */
export class FakeLlm implements Llm {
  readonly requests: SuggestionRequest[] = [];
  readonly readings: ReadRecipeRequest[] = [];
  failing = false;
  reading: z.input<typeof ModelReading> = { isRecipe: false };

  constructor(
    private readonly answers: Readonly<Record<string, z.input<typeof SuggestedItem>>> = {},
    private readonly answer?: (
      request: SuggestionRequest,
    ) => { name: string; suggested: z.input<typeof SuggestedItem> }[],
  ) {}

  async makeSuggestions(request: SuggestionRequest): Promise<SuggestionAnswer[]> {
    this.requests.push(request);
    if (this.failing) throw new LlmError("the fake is failing");
    const answers =
      this.answer?.(request) ??
      request.names.flatMap((name) => {
        const suggested = this.answers[name];
        return suggested ? [{ name, suggested }] : [];
      });
    // An answer that can't be read is left out, as the real adapter leaves it out.
    return answers.flatMap(({ name, suggested }) => {
      const parsed = SuggestedItem.safeParse(suggested);
      return parsed.success ? [{ name, suggested: parsed.data }] : [];
    });
  }

  async readRecipe(request: ReadRecipeRequest): Promise<RecipeReading> {
    this.readings.push(request);
    if (this.failing) throw new LlmError("the fake is failing", "read the recipe");
    const reading = recipeReadingOf(this.reading);
    if (!reading) throw new LlmError("an answer that could not be read", "read the recipe");
    return reading;
  }
}
