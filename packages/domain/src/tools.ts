import { z } from "zod";
import { type Caller, ResolvedCaller } from "./caller";
import { Household, SetupHouseholdInput } from "./household";
import { Item, NewItem, ResolveIngredientInput, ResolveIngredientOutput } from "./items";
import { Member, NewMember, RemoveMemberInput, UpdateMemberConstraintsInput, UpdateMemberInput } from "./members";
import {
  DeleteRecipeInput,
  GetRecipeInput,
  NewRecipe,
  Recipe,
  RecipeSummary,
  SearchRecipesInput,
  UnresolvedGroup,
  UpdateRecipeInput,
} from "./recipes";

/**
 * Topics a change notice can name; clients refetch the matching tools. Items are announced as
 * "recipes": a change to one changes the Recipes that resolve to it.
 */
export const ChangeTopic = z.enum(["household", "recipes"]);
export type ChangeTopic = z.infer<typeof ChangeTopic>;

type ToolDefinition = {
  input: z.ZodType;
  output: z.ZodType;
  /** The topic a successful call changes; absent for read-only tools. */
  changes?: ChangeTopic;
};

function defineTool<const T extends ToolDefinition>(definition: T): T {
  return definition;
}

/** Every tool Mise exposes. The PWA, the agent and any coordinator call these and nothing else. */
export const tools = {
  setup_household: defineTool({
    input: SetupHouseholdInput,
    output: Household,
    changes: "household",
  }),
  get_household: defineTool({
    input: z.object({}).strict(),
    output: Household.nullable(),
  }),
  add_member: defineTool({
    input: NewMember,
    output: Member,
    changes: "household",
  }),
  update_member: defineTool({
    input: UpdateMemberInput,
    output: Member,
    changes: "household",
  }),
  /** Replaces the Member's Constraints with the list given. */
  update_member_constraints: defineTool({
    input: UpdateMemberConstraintsInput,
    output: Member,
    changes: "household",
  }),
  /** Returns the Member as it was before removal. */
  remove_member: defineTool({
    input: RemoveMemberInput,
    output: Member,
    changes: "household",
  }),
  create_recipe: defineTool({
    input: NewRecipe,
    output: Recipe,
    changes: "recipes",
  }),
  get_recipe: defineTool({
    input: GetRecipeInput,
    output: Recipe,
  }),
  update_recipe: defineTool({
    input: UpdateRecipeInput,
    output: Recipe,
    changes: "recipes",
  }),
  /** Requires `confirm: true`. Returns the Recipe as it was before deletion. */
  delete_recipe: defineTool({
    input: DeleteRecipeInput,
    output: Recipe,
    changes: "recipes",
  }),
  /** Recipes in title order. */
  search_recipes: defineTool({
    input: SearchRecipesInput,
    output: z.array(RecipeSummary),
  }),
  /** Recipes missing a cuisine or a main protein, in title order; `update_recipe` sets them. */
  list_untagged_recipes: defineTool({
    input: z.object({}).strict(),
    output: z.array(RecipeSummary),
  }),
  /** Unresolved Ingredients grouped by their normalised text, most frequent first. */
  list_unresolved_ingredients: defineTool({
    input: z.object({}).strict(),
    output: z.array(UnresolvedGroup),
  }),
  /** Refuses a text that already names another Item. */
  resolve_ingredient: defineTool({
    input: ResolveIngredientInput,
    output: ResolveIngredientOutput,
    changes: "recipes",
  }),
  /** Refuses a name or alias that already names an Item. */
  create_item: defineTool({
    input: NewItem,
    output: Item,
    changes: "recipes",
  }),
  /** Every Item: the shipped ones in catalogue order, then the Household's in the order added. */
  list_items: defineTool({
    input: z.object({}).strict(),
    output: z.array(Item),
  }),
  get_caller: defineTool({
    input: z.object({}).strict(),
    output: ResolvedCaller.nullable(),
  }),
};

export type Tools = typeof tools;
export type ToolName = keyof Tools;
/** What a caller passes: defaulted fields may be omitted. */
export type ToolInput<N extends ToolName> = z.input<Tools[N]["input"]>;
/** What a handler receives once the input is validated and defaulted. */
export type ParsedToolInput<N extends ToolName> = z.output<Tools[N]["input"]>;
export type ToolOutput<N extends ToolName> = z.output<Tools[N]["output"]>;

/** What every tool handler is told about the call. */
export type ToolContext = {
  /** Null for calls Mise makes itself, such as scheduled jobs, which no one signed in for. */
  caller: Caller | null;
};

export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "already_set_up"
  | "not_set_up"
  | "not_found"
  | "email_in_use"
  | "name_in_use";

export type ToolError = {
  code: ToolErrorCode;
  message: string;
  issues?: { path: string; message: string }[];
};

export type ToolResult<T> = { ok: true; value: T } | { ok: false; error: ToolError };

/** The topic a successful call to this tool changes, if it changes anything. */
export function changeTopicOf(name: ToolName): ChangeTopic | undefined {
  const definition: ToolDefinition = tools[name];
  return definition.changes;
}

export function isToolName(name: unknown): name is ToolName {
  return typeof name === "string" && Object.hasOwn(tools, name);
}

export function parseToolInput<N extends ToolName>(name: N, input: unknown): ToolResult<ParsedToolInput<N>>;
export function parseToolInput(name: string, input: unknown): ToolResult<unknown>;
export function parseToolInput(name: string, input: unknown): ToolResult<unknown> {
  if (!isToolName(name)) {
    return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${name}` } };
  }
  const parsed = tools[name].input.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `Invalid input for ${name}`,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/** Broadcast to every connected client after a mutation; clients refetch through tools. */
export const ChangeNotice = z.object({
  type: z.literal("mise:change"),
  topic: ChangeTopic,
  revision: z.number().int().nonnegative(),
});
export type ChangeNotice = z.infer<typeof ChangeNotice>;
