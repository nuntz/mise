import {
  type ItemCatalogue,
  NewItem,
  normaliseItemName,
  type RecipeId,
  SUGGESTION_BATCH_SIZE,
  SuggestedItem,
  type Suggestion,
  type SuggestionAnswer,
  type SuggestionId,
  type ToolResult,
} from "@mise/domain";
import { z } from "zod";
import { countUnresolved, itemHandlers, readCatalogue, readUnresolvedGroups, unresolvedTextsIn } from "./items";
import type { Handlers } from "./tools";

type SuggestionRow = {
  id: number;
  text: string;
  suggested: string | null;
  suggested_at: string;
  dismissed_at: string | null;
};

/** A stored Suggestion: dismissed or not, and with no `suggested` when the model had no answer. */
type StoredSuggestion = { id: SuggestionId; text: string; suggested: SuggestedItem | null; suggestedAt: string };

type StoredRow = { suggestion: StoredSuggestion; dismissed: boolean };

type SuggestionTools = "list_suggestions" | "accept_suggestion" | "dismiss_suggestion";

/** The Suggestion tools that need only SQLite; `request_suggestions` asks the model, so the household runs it. */
export const suggestionHandlers: Pick<Handlers, SuggestionTools> = {
  list_suggestions: (sql) => {
    const order = new Map(readUnresolvedGroups(sql).map((group, index) => [group.text, index]));
    const listed = readSuggestions(sql)
      .flatMap(({ suggestion, dismissed }) => {
        const answered = withAnswer(suggestion);
        return answered && !dismissed && order.has(suggestion.text) ? [answered] : [];
      })
      .sort((a, b) => (order.get(a.text) ?? 0) - (order.get(b.text) ?? 0));
    return { ok: true, value: listed };
  },

  /** Goes through `resolve_ingredient` or `create_item`, so it resolves lines as they do. */
  accept_suggestion: (sql, input, context) => {
    const pending = pendingSuggestion(sql, input.id);
    if (!pending) return suggestionNotFound(input.id);
    sql.exec("DELETE FROM suggestion WHERE id = ?", input.id);
    const suggested = input.suggested ?? pending.suggested;
    // A Recipe trusts an Item's Allergens, so "none" is said by a person, never taken from the model (ADR 0009).
    if (!input.suggested && suggested.kind === "new" && suggested.allergens.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid_input",
          message: "A new Item with no Allergens is accepted with `suggested`, stating them",
          issues: [{ path: "suggested", message: "State the Allergens, even when there are none" }],
        },
      };
    }
    const { text } = pending;
    if (suggested.kind === "existing") {
      return itemHandlers.resolve_ingredient(sql, { text, item: suggested.item }, context);
    }
    const before = countUnresolved(sql);
    const created = itemHandlers.create_item(
      sql,
      NewItem.parse({
        name: suggested.name,
        section: suggested.section,
        unitFamily: suggested.unitFamily,
        allergens: suggested.allergens,
        aliases: normaliseItemName(suggested.name) === text ? [] : [text],
      }),
      context,
    );
    if (!created.ok) return created;
    return { ok: true, value: { item: created.value, resolved: before - countUnresolved(sql) } };
  },

  dismiss_suggestion: (sql, input) => {
    const pending = pendingSuggestion(sql, input.id);
    if (!pending) return suggestionNotFound(input.id);
    sql.exec("UPDATE suggestion SET dismissed_at = ? WHERE id = ?", new Date().toISOString(), input.id);
    return { ok: true, value: pending };
  },
};

/**
 * The texts `request_suggestions` asks about: those given that are Unresolved, or else the next batch
 * of Unresolved texts never asked about.
 */
export function textsToSuggest(sql: SqlStorage, texts?: readonly string[]): string[] {
  const unresolved = suggestable(readUnresolvedGroups(sql).map((group) => group.text));
  if (texts) {
    const wanted = new Set(texts.map(normaliseItemName));
    return unresolved.filter((text) => wanted.has(text));
  }
  return neverAsked(sql, unresolved).slice(0, SUGGESTION_BATCH_SIZE);
}

/** The Unresolved texts in these Recipes never asked about, as an import asks about them. */
export function newTextsIn(sql: SqlStorage, recipeIds: readonly RecipeId[]): string[] {
  return neverAsked(sql, suggestable(unresolvedTextsIn(sql, recipeIds)));
}

/** How many Unresolved texts have never been asked about. */
export function remainingToSuggest(sql: SqlStorage): number {
  return neverAsked(sql, suggestable(readUnresolvedGroups(sql).map((group) => group.text))).length;
}

/** Texts a model can be asked about: a line with no name ("2 cups") is fixed by editing its Recipe. */
function suggestable(texts: readonly string[]): string[] {
  return texts.filter((text) => text !== "");
}

/**
 * Stores the model's answers for `asked`, replacing what was there: a text with no answer is stored
 * without one, so it is not asked about again. Texts resolved while the model thought are skipped.
 * Returns the Suggestions made.
 */
export function storeSuggestions(
  sql: SqlStorage,
  asked: readonly string[],
  answers: readonly SuggestionAnswer[],
  now: string,
): Suggestion[] {
  const unresolved = new Set(readUnresolvedGroups(sql).map((group) => group.text));
  const stored: Suggestion[] = [];
  for (const text of asked) {
    if (!unresolved.has(text)) continue;
    const suggested = answers.find((answer) => answer.name === text)?.suggested ?? null;
    const { id } = sql
      .exec<{ id: number }>(
        `INSERT INTO suggestion (text, suggested, suggested_at, dismissed_at) VALUES (?, ?, ?, NULL)
         ON CONFLICT (text) DO UPDATE SET suggested = excluded.suggested, suggested_at = excluded.suggested_at,
           dismissed_at = NULL
         RETURNING id`,
        text,
        suggested && JSON.stringify(suggested),
        now,
      )
      .one();
    if (suggested) stored.push({ id, text, suggested, suggestedAt: now });
  }
  return stored;
}

/**
 * Every stored Suggestion; parsed, so bad rows throw (a `ZodError`), such as one naming an Item the
 * catalogue does not have.
 */
export function readSuggestions(sql: SqlStorage, catalogue: ItemCatalogue = readCatalogue(sql)): StoredRow[] {
  const Stored = z.object({
    id: z.number().int().positive(),
    text: z.string(),
    suggested: storedSuggested(catalogue).nullable(),
    suggestedAt: z.string(),
  });
  return sql
    .exec<SuggestionRow>("SELECT * FROM suggestion ORDER BY id")
    .toArray()
    .map((row) => ({
      suggestion: Stored.parse({
        id: row.id,
        text: row.text,
        suggested: row.suggested,
        suggestedAt: row.suggested_at,
      }),
      dismissed: row.dismissed_at !== null,
    }));
}

/** A SuggestedItem stored as JSON, of an Item `catalogue` has. */
function storedSuggested(catalogue: ItemCatalogue) {
  return z
    .string()
    .transform((json, ctx) => {
      try {
        return JSON.parse(json) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Not JSON" });
        return z.NEVER;
      }
    })
    .pipe(SuggestedItem)
    .refine((suggested) => suggested.kind === "new" || catalogue.item(suggested.item) !== undefined, "No such Item");
}

function neverAsked(sql: SqlStorage, texts: readonly string[]): string[] {
  const asked = new Set(
    sql
      .exec<{ text: string }>("SELECT text FROM suggestion")
      .toArray()
      .map((row) => row.text),
  );
  return texts.filter((text) => !asked.has(text));
}

/** A Suggestion not accepted or dismissed, with an answer. */
function pendingSuggestion(sql: SqlStorage, id: SuggestionId): Suggestion | null {
  const found = readSuggestions(sql).find(({ suggestion }) => suggestion.id === id);
  if (!found || found.dismissed) return null;
  return withAnswer(found.suggestion);
}

/** The stored Suggestion as a Suggestion, or null when the model had no answer. */
function withAnswer(suggestion: StoredSuggestion): Suggestion | null {
  const { suggested } = suggestion;
  return suggested ? { ...suggestion, suggested } : null;
}

function suggestionNotFound<T>(id: SuggestionId): ToolResult<T> {
  return { ok: false, error: { code: "not_found", message: `No Suggestion ${id} waiting to be accepted` } };
}
