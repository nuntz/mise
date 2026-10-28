import { z } from "zod";
import { CalendarToken } from "./calendar";
import { type Caller, ResolvedCaller } from "./caller";
import { CancelConfirmationInput, PendingConfirmation } from "./confirmations";
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
import {
  EffortBudgets,
  Household,
  SetEffortBudgetsInput,
  SetupHouseholdInput,
  UpdateHouseholdSettingsInput,
} from "./household";
import {
  Draft,
  DraftInput,
  DriveSyncStarted,
  ImportFlag,
  ImportRun,
  ImportScreenshotsInput,
  ImportTextInput,
  ImportTextOutput,
  ImportUrlInput,
  ImportUrlOutput,
  RunPaprikaImportInput,
} from "./imports";
import { Item, NewItem, ResolveIngredientInput, ResolveIngredientOutput, StoreSection, UpdateItemInput } from "./items";
import { AddKitchenDisplayInput, KitchenDisplay, NewKitchenDisplay, RevokeKitchenDisplayInput } from "./kitchenDisplay";
import { Member, NewMember, RemoveMemberInput, UpdateMemberConstraintsInput, UpdateMemberInput } from "./members";
import { PushDevice, PushDeviceInput, PushKey, SubscribePushInput } from "./push";
import {
  DeleteRecipeInput,
  GetRecipeInput,
  NewReadyMadeRecipe,
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
  AcceptSuggestionInput,
  DismissSuggestionInput,
  RequestSuggestionsInput,
  RequestSuggestionsOutput,
  Suggestion,
} from "./suggestions";
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
 * Recipes, and its log and flags are read beside them; and so are Suggestions, which are read beside
 * the Unresolved Ingredients they are for and resolve them when accepted. "plan" is the Weeks and their Slots;
 * "grocery" their Grocery Lists and the Household's Staples, which the lists buy and their Have Ticks
 * restock; the lists also depend on the plan, the Recipes and the Household. "chat" is the Household's
 * conversation with the agent, announced once each turn is answered, and its confirmations.
 */
export const ChangeTopic = z.enum(["household", "recipes", "plan", "grocery", "chat"]);
export type ChangeTopic = z.infer<typeof ChangeTopic>;

/**
 * When a call from the agent waits for a person's tap instead of running (ADR 0024): always, for the
 * destructive tools; for a Slot, when it carries an Override or loosens the Guests' Hard
 * Constraints; or, for a Member, when it loosens a Hard Constraint (removes one, makes it a dislike, or
 * removes a Member who has one) or changes their name or sign-in email, which decide who the agent
 * takes someone for. A call from a screen runs at once: the PWA
 * asks in its own dialogs.
 */
export type ConfirmationCase = "always" | "slot" | "member";

type ToolDefinition = {
  input: z.ZodType;
  output: z.ZodType;
  /**
   * The topic a successful call changes; absent for read-only tools, and for a device's own
   * notification settings, which no other screen shows.
   */
  changes?: ChangeTopic;
  /** When a call from the agent needs a person's tap; absent for tools that never do. */
  confirm?: ConfirmationCase;
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
  /**
   * Changes the settings given, validated as at setup. A new week start applies from the next Week:
   * existing Weeks keep their dates (ADR 0021).
   */
  update_household_settings: defineTool({
    input: UpdateHouseholdSettingsInput,
    output: Household,
    changes: "household",
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
    confirm: "member",
  }),
  /** Replaces the Member's Constraints with the list given. */
  update_member_constraints: defineTool({
    input: UpdateMemberConstraintsInput,
    output: Member,
    changes: "household",
    confirm: "member",
  }),
  /** Returns the Member as it was before removal. */
  remove_member: defineTool({
    input: RemoveMemberInput,
    output: Member,
    changes: "household",
    confirm: "member",
  }),
  create_recipe: defineTool({
    input: NewRecipe,
    output: Recipe,
    changes: "recipes",
  }),
  /**
   * Creates the product's Household Item, unless the product already names one, and the Ready-made
   * Recipe. Refuses a new product without its Allergens stated (`invalid_input`), and one naming an
   * Item that is weighed or measured rather than bought whole (`measured_item`).
   */
  create_ready_made_recipe: defineTool({
    input: NewReadyMadeRecipe,
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
    confirm: "always",
  }),
  /** Recipes in title order; Drafts are left out, for `list_drafts`. */
  search_recipes: defineTool({
    input: SearchRecipesInput,
    output: z.array(RecipeSummary),
  }),
  /** Recipes missing a cuisine or a main protein, in title order, Drafts left out; `update_recipe` sets them. */
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
  /**
   * Asks the model for Suggestions (ADR 0023); see `RequestSuggestionsInput`. One batch per call:
   * call again while `remaining` is above 0. Refuses with `model_failed` when the model fails.
   */
  request_suggestions: defineTool({
    input: RequestSuggestionsInput,
    output: RequestSuggestionsOutput,
    changes: "recipes",
  }),
  /** Suggestions not yet accepted or dismissed whose text is still Unresolved, most frequent text first. */
  list_suggestions: defineTool({
    input: z.object({}).strict(),
    output: z.array(Suggestion),
  }),
  /**
   * Refuses a Suggestion already accepted or dismissed (`not_found`), a new Item with no Allergens
   * accepted without `suggested` stating them (`invalid_input`), and a name that already names another
   * Item (`name_in_use`), as `resolve_ingredient` and `create_item` do.
   */
  accept_suggestion: defineTool({
    input: AcceptSuggestionInput,
    output: ResolveIngredientOutput,
    changes: "recipes",
  }),
  /** Refuses a Suggestion already accepted or dismissed (`not_found`). Returns the Suggestion. */
  dismiss_suggestion: defineTool({
    input: DismissSuggestionInput,
    output: Suggestion,
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
  /**
   * Reads pasted text with the model (ADR 0023) into a Draft Recipe, logged as an Import Run of source
   * `text`, and flagged if it looks like a Recipe already kept. Text pasted before is skipped, and text
   * holding no recipe creates nothing, logged as the run's error. Refuses with `model_failed` when the
   * model fails, logging nothing. With `draft`, fills that link-only Draft instead, keeping its link
   * (an edit in Mise, so importing the link again flags it rather than overwriting it); refuses
   * anything else (`not_found`).
   */
  import_text: defineTool({
    input: ImportTextInput,
    output: ImportTextOutput,
    changes: "recipes",
  }),
  /**
   * Reads uploaded screenshots together with the model's vision (ADR 0023) into a Draft Recipe,
   * logged as an Import Run of source `screenshot`, as `import_text` reads text: the same screenshots
   * read again are skipped, screenshots holding no recipe create nothing, and `model_failed` logs
   * nothing. With `draft`, fills that link-only Draft instead. The uploads are deleted once read;
   * an upload that is not there refuses the call (`not_found`).
   */
  import_screenshots: defineTool({
    input: ImportScreenshotsInput,
    output: ImportTextOutput,
    changes: "recipes",
  }),
  /**
   * Fetches a recipe page and imports it, logged as an Import Run of source `url`, upserted on the
   * page's canonical URL. A schema.org Recipe in its JSON-LD makes a Recipe, with the Recipe's photo
   * (else the page's `og:image`); otherwise the model reads the page's text into a Draft. A page that
   * can't be fetched, or holds no recipe, or that the model fails to read, makes a link-only Draft, so
   * the link is never lost; why is logged as the run's error. Importing an unchanged page again is
   * skipped, without asking the model. A TikTok video is read from its oEmbed caption and thumbnail
   * instead (source `tiktok`, upserted on the video's URL), kept link-only while TikTok sends none, and an Instagram link is kept link-only
   * (source `instagram`) without fetching anything.
   */
  import_url: defineTool({
    input: ImportUrlInput,
    output: ImportUrlOutput,
    changes: "recipes",
  }),
  /**
   * Starts reading the Google Docs in the Drive folder shared with the deployment's service account,
   * and its subfolders, and answers at once: the sync is logged as an Import Run of source `gdrive`
   * when it finishes, minutes later for a full folder, and announced as a change to `recipes`. Answers
   * `alreadyRunning` while a sync is running, and starts no second one; the household also runs it
   * every night.
   * The model reads each new or changed Doc (ADR 0023) into a Draft Recipe, upserted on the Doc's id
   * at its modified time, with its first image as the photo and its subfolders as tags. A Doc that
   * holds no recipe is logged as the run's error, with its link, and skipped until it changes; so is
   * a Draft discarded in Mise. A Doc removed from the folder leaves its Recipe. Refuses with
   * `not_configured` when the deployment has no service account key or folder.
   */
  sync_drive_folder: defineTool({
    input: z.object({}).strict(),
    output: DriveSyncStarted,
    changes: "recipes",
  }),
  /** Draft Recipes, newest first. */
  list_drafts: defineTool({
    input: z.object({}).strict(),
    output: z.array(Draft),
  }),
  /** Makes a Draft a Recipe like any other, to plan and shop. Refuses a Recipe that is no Draft (`not_found`). */
  accept_draft: defineTool({
    input: DraftInput,
    output: Recipe,
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
  /**
   * Refuses a Draft Recipe (`draft_recipe`), and a change that leaves the Slot with a new Conflict it
   * doesn't override (`constraint_conflict`).
   */
  set_slot: defineTool({
    input: SetSlotInput,
    output: Slot,
    changes: "plan",
    confirm: "slot",
  }),
  /** Returns the Slots changed: one, or the day's three. Refuses new Conflicts as `set_slot` does. */
  set_diners: defineTool({
    input: SetDinersInput,
    output: z.array(Slot),
    changes: "plan",
    confirm: "slot",
  }),
  /** Refuses new Conflicts as `set_slot` does. */
  set_guests: defineTool({
    input: SetGuestsInput,
    output: Slot,
    changes: "plan",
    confirm: "slot",
  }),
  /**
   * Refuses a Slot to link to that is not earlier (`not_earlier`), holds no Recipe (`no_recipe`) or a
   * Draft (`draft_recipe`), and new Conflicts as `set_slot` does. Returns the Slot.
   */
  link_leftovers: defineTool({
    input: LinkLeftoversInput,
    output: Slot,
    changes: "plan",
    confirm: "slot",
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
    confirm: "always",
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
  /**
   * Makes an Item that is no Staple one first, as `upsert_staple` does. Refuses an Item that doesn't
   * exist (`not_found`). Returns the Staple.
   */
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
  /** Every Kitchen Display paired to the Household, oldest first. */
  list_kitchen_displays: defineTool({
    input: z.object({}).strict(),
    output: z.array(KitchenDisplay),
  }),
  /**
   * Pairs a new Kitchen Display: makes its token, which reads only the Day Sheet. Returns it with the
   * token, shown this once; only a hash is kept.
   */
  add_kitchen_display: defineTool({
    input: AddKitchenDisplayInput,
    output: NewKitchenDisplay,
    changes: "household",
  }),
  /** Revokes a Kitchen Display's token: its next request is refused. Refuses an unknown id (`not_found`). Returns it. */
  revoke_kitchen_display: defineTool({
    input: RevokeKitchenDisplayInput,
    output: KitchenDisplay,
    changes: "household",
  }),
  /**
   * Withdraws a confirmation the agent asked for that still waits for a tap (ADR 0024), from the chat
   * or by the agent when told "never mind". Refuses one no longer waiting (`not_found`). Returns it.
   */
  cancel_confirmation: defineTool({
    input: CancelConfirmationInput,
    output: PendingConfirmation,
    changes: "chat",
  }),
  /** The key a device subscribes to notifications with. Refuses with `not_configured` when the deployment has none. */
  get_push_key: defineTool({
    input: z.object({}).strict(),
    output: PushKey,
  }),
  /**
   * Turns notifications on for this device, for the kinds given, or changes its kinds. Every device
   * subscribed gets every kind it chose, whoever signed in on it.
   */
  subscribe_push: defineTool({
    input: SubscribePushInput,
    output: PushDevice,
  }),
  /** The device subscribed at this endpoint, or null if none is. */
  get_push_device: defineTool({
    input: PushDeviceInput,
    output: PushDevice.nullable(),
  }),
  /** Turns notifications off for the device. Refuses one not subscribed (`not_found`). Returns it as it was. */
  unsubscribe_push: defineTool({
    input: PushDeviceInput,
    output: PushDevice,
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
  | "measured_item"
  | "constraint_conflict"
  | "no_recipe"
  | "not_yet"
  | "not_cooked"
  | "not_built"
  | "not_earlier"
  | "draft_recipe"
  | "model_failed"
  | "not_configured"
  | "expired";

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

/** When a call to this tool from the agent needs a person's tap, if it ever does. */
export function confirmationCaseOf(name: ToolName): ConfirmationCase | undefined {
  const definition: ToolDefinition = tools[name];
  return definition.confirm;
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
