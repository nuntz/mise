import { z } from "zod";
import { CalendarToken } from "./calendar";
import { type Caller, ResolvedCaller } from "./caller";
import { type Conflict, SlotConflict } from "./conflicts";
import {
  AddGroceryLineInput,
  BuildGroceryListInput,
  GetGroceryListInput,
  GroceryLine,
  GroceryList,
  SetHaveTickInput,
  SetStoreSectionOrderInput,
} from "./grocery";
import { EffortBudgets, Household, SetEffortBudgetsInput, SetupHouseholdInput } from "./household";
import { ImportFlag, ImportRun, RunPaprikaImportInput } from "./imports";
import { Item, NewItem, ResolveIngredientInput, ResolveIngredientOutput, StoreSection, UpdateItemInput } from "./items";
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
import {
  DueStaples,
  ListStaplesInput,
  RecordStapleStatusInput,
  RemoveStapleInput,
  Staple,
  UpsertStapleInput,
} from "./staples";
import {
  CheckSlotConstraintsInput,
  ClearWeekInput,
  GetWeekInput,
  LinkLeftoversInput,
  type LocalDate,
  LockSlotInput,
  MarkCookedInput,
  type Meal,
  ProposeWeekInput,
  RateRecipeInput,
  ReviewWeekInput,
  SetDinersInput,
  SetGuestsInput,
  SetSlotInput,
  SetWeekEffortBudgetsInput,
  Slot,
  Week,
} from "./weeks";

/**
 * Topics a change notice can name; clients refetch the matching tools. Items are announced as
 * "recipes": a change to one changes the Recipes that resolve to it. So are imports: a run changes
 * Recipes, and its log and flags are read beside them. "plan" is the Weeks and their Slots;
 * "grocery" their Grocery Lists and the Household's Staples, which the lists buy and their Have Ticks
 * restock; the lists also depend on the plan, the Recipes and the Household.
 */
export const ChangeTopic = z.enum(["household", "recipes", "plan", "grocery"]);
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
  /** Returns every weekday's default Effort Budget. */
  set_effort_budgets: defineTool({
    input: SetEffortBudgetsInput,
    output: EffortBudgets,
    changes: "household",
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
  /**
   * Refuses a name or alias that already names another Item (`name_in_use`), and a change to a
   * shipped Item's name, unit family or Allergens (`shipped_item`). Returns the Item.
   */
  update_item: defineTool({
    input: UpdateItemInput,
    output: Item,
    changes: "recipes",
  }),
  /** Every Item: the shipped ones in catalogue order, then the Household's in the order added. */
  list_items: defineTool({
    input: z.object({}).strict(),
    output: z.array(Item),
  }),
  /**
   * Imports the export uploaded with `PUT …/imports/paprika` (ADR 0011), then deletes the upload.
   * Upserts each Recipe on its Paprika uid and never deletes one.
   */
  run_paprika_import: defineTool({
    input: RunPaprikaImportInput,
    output: ImportRun,
    changes: "recipes",
  }),
  /** Import runs, newest first. */
  list_import_runs: defineTool({
    input: z.object({}).strict(),
    output: z.array(ImportRun),
  }),
  /** Recipes imports flagged for a merge or as possible duplicates, newest first. */
  list_import_flags: defineTool({
    input: z.object({}).strict(),
    output: z.array(ImportFlag),
  }),
  /** The Week with every Slot, stored or not; see `GetWeekInput`. */
  get_week: defineTool({
    input: GetWeekInput,
    output: Week,
  }),
  /** Refuses a change that leaves the Slot with a new Conflict it doesn't override (`constraint_conflict`). */
  set_slot: defineTool({
    input: SetSlotInput,
    output: Slot,
    changes: "plan",
  }),
  /** Returns the Slots changed: one, or the day's three. Refuses new Conflicts as `set_slot` does. */
  set_diners: defineTool({
    input: SetDinersInput,
    output: z.array(Slot),
    changes: "plan",
  }),
  /** Refuses new Conflicts as `set_slot` does. */
  set_guests: defineTool({
    input: SetGuestsInput,
    output: Slot,
    changes: "plan",
  }),
  /**
   * Refuses a Slot to link to that is not earlier (`not_earlier`) or holds no Recipe (`no_recipe`),
   * and new Conflicts as `set_slot` does. Returns the Slot.
   */
  link_leftovers: defineTool({
    input: LinkLeftoversInput,
    output: Slot,
    changes: "plan",
  }),
  /** Read-only: what a change would conflict with, before making it. */
  check_slot_constraints: defineTool({
    input: CheckSlotConstraintsInput,
    output: z.array(SlotConflict),
  }),
  /** A Locked Slot keeps its Recipe when the Week is proposed again; it can still be edited by hand. */
  lock_slot: defineTool({
    input: LockSlotInput,
    output: Slot,
    changes: "plan",
  }),
  /**
   * Requires `confirm: true`. Puts every Slot of the Week back as it starts, Locked ones too, but
   * leaves cooked ones as they were; returns the Week.
   */
  clear_week: defineTool({
    input: ClearWeekInput,
    output: Week,
    changes: "plan",
  }),
  /**
   * Fills the Week's dinners that aren't Locked or decided by hand, with a reason for each; see
   * `ProposeWeekInput`. Returns the Week.
   */
  propose_week: defineTool({
    input: ProposeWeekInput,
    output: Week,
    changes: "plan",
  }),
  /** Returns the Week, with its Effort Budgets as they now are. */
  set_week_effort_budgets: defineTool({
    input: SetWeekEffortBudgetsInput,
    output: Week,
    changes: "plan",
  }),
  /** Marks the Week as looked over since it was proposed, or not. */
  review_week: defineTool({
    input: ReviewWeekInput,
    output: Week,
    changes: "plan",
  }),
  /** Refuses a Slot without a Recipe (`no_recipe`), or dated after today (`not_yet`). Returns the Slot. */
  mark_cooked: defineTool({
    input: MarkCookedInput,
    output: Slot,
    changes: "plan",
  }),
  /** Refuses a Slot not marked cooked (`not_cooked`). Returns the Slot. */
  rate_recipe: defineTool({
    input: RateRecipeInput,
    output: Slot,
    changes: "plan",
  }),
  /** Builds or rebuilds the Week's Grocery List; see `BuildGroceryListInput`. */
  build_grocery_list: defineTool({
    input: BuildGroceryListInput,
    output: GroceryList,
    changes: "grocery",
  }),
  /** The Week's Grocery List; null until it is first built. */
  get_grocery_list: defineTool({
    input: GetGroceryListInput,
    output: GroceryList.nullable(),
  }),
  /** Returns the line. Refuses a line that doesn't exist (`not_found`). */
  set_have_tick: defineTool({
    input: SetHaveTickInput,
    output: GroceryLine,
    changes: "grocery",
  }),
  /** Refuses a Week whose Grocery List isn't built yet (`not_built`). Returns the line. */
  add_grocery_line: defineTool({
    input: AddGroceryLineInput,
    output: GroceryLine,
    changes: "grocery",
  }),
  /** Refuses an Item that doesn't exist (`not_found`). Returns the Staple. */
  upsert_staple: defineTool({
    input: UpsertStapleInput,
    output: Staple,
    changes: "grocery",
  }),
  /** Refuses an Item that is no Staple (`not_found`). Returns the Staple as it was. */
  remove_staple: defineTool({
    input: RemoveStapleInput,
    output: Staple,
    changes: "grocery",
  }),
  list_staples: defineTool({
    input: ListStaplesInput,
    output: z.array(Staple),
  }),
  /** The Staples a pantry check-in asks about today; see `dueStaples`. */
  list_due_staples: defineTool({
    input: z.object({}).strict(),
    output: DueStaples,
  }),
  /** Refuses an Item that is no Staple (`not_found`). Returns the Staple. */
  record_staple_status: defineTool({
    input: RecordStapleStatusInput,
    output: Staple,
    changes: "grocery",
  }),
  /** Returns every Store Section in the Household's walking order. */
  set_store_section_order: defineTool({
    input: SetStoreSectionOrderInput,
    output: z.array(StoreSection),
    changes: "household",
  }),
  /** The calendar feed's token; null until `rotate_calendar_token` first makes one. */
  get_calendar_token: defineTool({
    input: z.object({}).strict(),
    output: CalendarToken.nullable(),
  }),
  /** Makes a new calendar feed token; the old one stops working at once. Returns the new one. */
  rotate_calendar_token: defineTool({
    input: z.object({}).strict(),
    output: CalendarToken,
    changes: "household",
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
  | "name_in_use"
  | "shipped_item"
  | "constraint_conflict"
  | "no_recipe"
  | "not_yet"
  | "not_cooked"
  | "not_built"
  | "not_earlier";

/** A Conflict a change was refused for, and the Slot it would have been in. */
export type RefusedConflict = Conflict & { date: LocalDate; meal: Meal };

export type ToolError = {
  code: ToolErrorCode;
  message: string;
  issues?: { path: string; message: string }[];
  /** With `constraint_conflict`: every Conflict the change would have brought that no override covered. */
  conflicts?: RefusedConflict[];
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
