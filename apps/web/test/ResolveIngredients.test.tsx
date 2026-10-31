import {
  DEFAULT_EFFORT_BUDGETS,
  type Household,
  ITEMS,
  type RecipeSummary,
  STORE_SECTIONS,
  type Suggestion,
  type UnresolvedGroup,
} from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import { createFakeClient } from "./fakeClient";
import { primaries } from "./primaries";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  voiceMinutesPerDay: 30,
  members: [],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const groups: UnresolvedGroup[] = [
  {
    text: "gochujang",
    count: 2,
    lines: ["2 tbsp gochujang", "1 tbsp Gochujang"],
    recipes: [
      { id: 1, title: "Bibimbap" },
      { id: 2, title: "Tteokbokki" },
    ],
  },
  { text: "beurre", count: 1, lines: ["1 tbsp beurre"], recipes: [{ id: 3, title: "Toast" }] },
  { text: "", count: 1, lines: ["2 cups"], recipes: [{ id: 3, title: "Toast" }] },
];

const suggestions: Suggestion[] = [
  {
    id: 7,
    text: "gochujang",
    suggested: { kind: "new", name: "gochujang", section: "international", unitFamily: "volume", allergens: ["soy"] },
    suggestedAt: "2026-10-23T12:00:00.000Z",
  },
  { id: 8, text: "beurre", suggested: { kind: "existing", item: "butter" }, suggestedAt: "2026-10-23T12:00:00.000Z" },
];

const untagged: RecipeSummary[] = [
  {
    id: 1,
    title: "Bibimbap",
    tags: [],
    effortMinutes: null,
    cuisine: "korean",
    mainProtein: null,
    course: null,
    readyMade: false,
    allergens: { kind: "known", allergens: [] },
    photoKey: null,
  },
];

/**
 * A client with fixed Unresolved Ingredients, their Suggestions and untagged Recipes that records every
 * tool call made. `request_suggestions` answers with `requested` in turn.
 */
function fakeClient({
  requested = [],
  listed = suggestions,
  waiting = { groups, untagged },
}: {
  requested?: unknown[];
  listed?: Suggestion[];
  waiting?: { groups: UnresolvedGroup[]; untagged: RecipeSummary[] };
} = {}) {
  const calls: { name: string; input: unknown }[] = [];
  const { client } = createFakeClient(async (name: string, input: Record<string, unknown>) => {
    calls.push({ name, input });
    switch (name) {
      case "get_household":
        return { ok: true, value: household };
      case "search_recipes":
        return { ok: true, value: [] };
      case "list_items":
        return { ok: true, value: ITEMS };
      case "list_unresolved_ingredients":
        return { ok: true, value: waiting.groups };
      case "list_suggestions":
        return { ok: true, value: listed };
      case "request_suggestions":
        return requested.shift();
      case "accept_suggestion":
        return { ok: true, value: { item: ITEMS[0], resolved: 1 } };
      case "dismiss_suggestion":
        return { ok: true, value: suggestions[0] };
      case "list_untagged_recipes":
        return { ok: true, value: waiting.untagged };
      case "resolve_ingredient":
        return { ok: true, value: { item: ITEMS[0], resolved: 1 } };
      case "create_item":
        return input.name === "eggs"
          ? { ok: false, error: { code: "name_in_use", message: "" } }
          : { ok: true, value: { ...ITEMS[0], ...input, id: "household:1" } };
      case "update_recipe":
        return { ok: true, value: {} };
      default:
        throw new Error(`Unexpected tool ${name}`);
    }
  });
  return { client, calls };
}

async function openPage(name: string, options?: Parameters<typeof fakeClient>[0]) {
  const user = userEvent.setup();
  const fake = fakeClient(options);
  render(() => <App client={fake.client} />);
  await user.click(await screen.findByRole("button", { name: "Household" }));
  await user.click(await screen.findByRole("button", { name }));
  return { user, ...fake };
}

test("Unresolved Ingredients are listed by text, with their lines and Recipes", async () => {
  await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  expect(
    within(gochujang).getByText("2 lines, in Bibimbap, Tteokbokki · “2 tbsp gochujang” · “1 tbsp Gochujang”"),
  ).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Resolve Ingredients" }).nextElementSibling?.textContent).toBe(
    "3 Unresolved",
  );
  const head = screen.getByRole("heading", { name: "Unresolved" });
  expect(head.parentElement?.querySelector(".chip")?.textContent).toBe("3");
  expect(screen.getAllByRole("article").map((article) => article.getAttribute("aria-label"))).toEqual([
    "Gochujang",
    "Beurre",
    "(no name)",
  ]);
  const blank = screen.getByRole("article", { name: "(no name)" });
  expect(within(blank).getByText("These lines name no Item. Edit their Recipes to say what they are.")).toBeTruthy();
  expect(within(blank).queryByRole("button")).toBeNull();
});

test("an amber banner names the Recipes whose Allergens are unknown until these are resolved", async () => {
  await openPage("Resolve Ingredients");

  // Toast has two Unresolved lines and is named once.
  const banner = await screen.findByText("Bibimbap, Tteokbokki, Toast: Allergens unknown until these are resolved.");
  expect(banner.closest(".banner-amber")).toBeTruthy();
});

test("a group is mapped to an existing Item by its name", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const beurre = await screen.findByRole("article", { name: "Beurre" });
  await user.click(within(beurre).getByRole("button", { name: "Map to an Item" }));
  // By an alias of the Item, not only its name.
  await user.type(within(beurre).getByRole("combobox", { name: "Item" }), "unsalted butters");
  await user.click(within(beurre).getByRole("button", { name: "Resolve" }));

  expect(calls.find((call) => call.name === "resolve_ingredient")?.input).toEqual({ text: "beurre", item: "butter" });
});

test("a name that is no Item asks to pick from the list", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const beurre = await screen.findByRole("article", { name: "Beurre" });
  await user.click(within(beurre).getByRole("button", { name: "Map to an Item" }));
  await user.type(within(beurre).getByRole("combobox", { name: "Item" }), "unobtainium");
  await user.click(within(beurre).getByRole("button", { name: "Resolve" }));

  expect(within(beurre).getByRole("alert").textContent).toBe("Pick an Item from the list, or create a new one.");
  expect(calls.some((call) => call.name === "resolve_ingredient")).toBe(false);
});

test("a new Item is created from a group with its Allergens and Store Section, the text kept as an alias", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Create an Item" }));
  const name = within(gochujang).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "Korean chili paste");
  await user.selectOptions(within(gochujang).getByRole("combobox", { name: "Store Section" }), "international");
  await user.click(within(gochujang).getByRole("button", { name: "Volume" }));
  await user.click(within(gochujang).getByRole("checkbox", { name: "Soy" }));
  await user.click(within(gochujang).getByRole("checkbox", { name: "Wheat" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(calls.find((call) => call.name === "create_item")?.input).toEqual({
    name: "Korean chili paste",
    section: "international",
    unitFamily: "volume",
    allergens: ["soy", "wheat"],
    aliases: ["gochujang"],
  });
});

test("creating an Item opens inline: the alias hint, how it's measured as segments, Allergens as toggle chips", async () => {
  const { user } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Create an Item" }));
  expect(within(gochujang).getByText("If you rename it, “gochujang” is kept as another name for it.")).toBeTruthy();
  const measured = within(gochujang).getByRole("group", { name: "Measured by" });
  expect(measured.querySelector(".segmented")).toBeTruthy();
  expect(within(measured).getByRole("button", { name: "Count" }).getAttribute("aria-pressed")).toBe("true");
  await user.click(within(measured).getByRole("button", { name: "Weight" }));
  expect(within(measured).getByRole("button", { name: "Weight" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(measured).getByRole("button", { name: "Count" }).getAttribute("aria-pressed")).toBe("false");
  const soy = within(gochujang).getByRole("checkbox", { name: "Soy" });
  expect(soy.closest("label")?.classList.contains("toggle-chip")).toBe(true);
  const none = within(gochujang).getByRole("checkbox", { name: "Contains none of these" });
  expect(none.closest("label")?.classList.contains("toggle-chip")).toBe(true);
  expect(within(gochujang).getByRole("button", { name: "Create Item" }).className).toBe("button-primary");
  expect(within(gochujang).getByRole("button", { name: "Cancel" }).className).toBe("button-quiet");
  // Gochujang's own Accept goes while it is being created; Beurre's stays.
  expect(primaries()).toEqual(["Create Item", "Accept"]);
});

test("a new Item needs its Allergens ticked, or none of them ticked on purpose", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Create an Item" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(within(gochujang).getByRole("alert").textContent).toBe(
    'Tick the Allergens it contains, or "Contains none of these".',
  );
  expect(calls.some((call) => call.name === "create_item")).toBe(false);

  await user.click(within(gochujang).getByRole("checkbox", { name: "Contains none of these" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(calls.find((call) => call.name === "create_item")?.input).toMatchObject({ allergens: [] });
});

test("a new Item named as the group has no alias, and a name in use is reported", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Create an Item" }));
  await user.click(within(gochujang).getByRole("checkbox", { name: "Contains none of these" }));
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));
  const name = within(gochujang).getByRole("textbox", { name: "Name" });
  await user.clear(name);
  await user.type(name, "eggs");
  await user.click(within(gochujang).getByRole("button", { name: "Create Item" }));

  expect(calls.find((call) => call.name === "create_item")?.input).toMatchObject({ name: "gochujang", aliases: [] });
  expect((await within(gochujang).findByRole("alert")).textContent).toBe("That name already belongs to another Item.");
});

test("a Suggestion shows on its group, marked as AI-drafted and not guaranteed complete", async () => {
  await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  const suggestion = await within(gochujang).findByRole("region", { name: "Suggestion" });
  expect(suggestion.textContent).toContain("AI-drafted, not guaranteed complete");
  expect(within(screen.getByRole("article", { name: "(no name)" })).queryByRole("region")).toBeNull();
});

test("a Suggestion is a raised AI note: its disclosure, an AI-drafted chip, the Item and its Allergens as chips", async () => {
  await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  const suggestion = await within(gochujang).findByRole("region", { name: "Suggestion" });
  expect(suggestion.classList.contains("ai-note")).toBe(true);
  // Word for word, as its own sentence.
  expect(
    within(suggestion).getByText(
      "AI-drafted, not guaranteed complete. Check it, Allergens above all, before accepting.",
    ),
  ).toBeTruthy();
  expect(within(suggestion).getByText("AI-drafted").classList.contains("chip")).toBe(true);
  expect(within(suggestion).getByText("Gochujang").classList.contains("name")).toBe(true);
  expect(within(suggestion).getByText("A new Item, in International")).toBeTruthy();
  expect(within(suggestion).getByText("Soy").classList.contains("chip")).toBe(true);

  const beurre = screen.getByRole("article", { name: "Beurre" });
  const existing = within(beurre).getByRole("region", { name: "Suggestion" });
  expect(within(existing).getByText("Butter").classList.contains("name")).toBe(true);
  expect(within(existing).getByText("Milk").classList.contains("chip")).toBe(true);
});

test("a Suggestion's Accept is its primary, Edit a row button and Dismiss quiet", async () => {
  await openPage("Resolve Ingredients");

  const beurre = await screen.findByRole("article", { name: "Beurre" });
  const suggestion = await within(beurre).findByRole("region", { name: "Suggestion" });
  expect(within(suggestion).getByRole("button", { name: "Accept" }).className).toBe("button-primary");
  expect(within(suggestion).getByRole("button", { name: "Edit" }).className).toBe("");
  expect(within(suggestion).getByRole("button", { name: "Dismiss" }).className).toBe("button-quiet");
});

test("a Suggestion is accepted, or dismissed, in one tap", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const beurre = await screen.findByRole("article", { name: "Beurre" });
  await user.click(await within(beurre).findByRole("button", { name: "Accept" }));
  const gochujang = screen.getByRole("article", { name: "Gochujang" });
  await user.click(within(gochujang).getByRole("button", { name: "Dismiss" }));

  expect(calls.find((call) => call.name === "accept_suggestion")?.input).toEqual({ id: 8 });
  expect(calls.find((call) => call.name === "dismiss_suggestion")?.input).toEqual({ id: 7 });
});

test("a Suggestion for a new Item is accepted after a person edits its Allergens", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  await user.click(await within(gochujang).findByRole("button", { name: "Edit" }));
  expect(within(gochujang).getByRole<HTMLInputElement>("checkbox", { name: "Soy" }).checked).toBe(true);
  await user.click(within(gochujang).getByRole("checkbox", { name: "Wheat" }));
  await user.click(within(gochujang).getByRole("button", { name: "Accept" }));

  expect(calls.find((call) => call.name === "accept_suggestion")?.input).toEqual({
    id: 7,
    suggested: {
      kind: "new",
      name: "gochujang",
      section: "international",
      unitFamily: "volume",
      allergens: ["soy", "wheat"],
    },
  });
});

test("a Suggestion of a new Item with no Allergens is accepted only once a person ticks none", async () => {
  const noAllergens: Suggestion = {
    id: 7,
    text: "gochujang",
    suggested: { kind: "new", name: "gochujang", section: "international", unitFamily: "volume", allergens: [] },
    suggestedAt: "2026-10-23T12:00:00.000Z",
  };
  const { user, calls } = await openPage("Resolve Ingredients", { listed: [noAllergens] });

  const gochujang = await screen.findByRole("article", { name: "Gochujang" });
  const suggestion = await within(gochujang).findByRole("region", { name: "Suggestion" });
  // The model's "none" isn't a person's: amber, never the plain chip of an Item known to have none.
  expect(within(suggestion).getByText("No Allergens suggested").classList.contains("chip-amber")).toBe(true);
  expect(suggestion.textContent).toContain(
    'To accept it, choose Edit and tick "Contains none of these" if that is right.',
  );
  expect(within(suggestion).queryByRole("button", { name: "Accept" })).toBeNull();
  await user.click(within(suggestion).getByRole("button", { name: "Edit" }));
  expect(within(gochujang).getByRole<HTMLInputElement>("checkbox", { name: "Contains none of these" }).checked).toBe(
    false,
  );
  const accept = within(gochujang).getByRole("button", { name: "Accept" });
  await user.click(accept);
  expect(calls.some((call) => call.name === "accept_suggestion")).toBe(false);
  // Said beside the button pressed, not above the group where it goes unseen.
  const alert = within(gochujang).getByRole("alert");
  expect(alert.textContent).toBe('Tick the Allergens it contains, or "Contains none of these".');
  expect(accept.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(within(gochujang).getByRole("checkbox", { name: "Contains none of these" }));
  await user.click(within(gochujang).getByRole("button", { name: "Accept" }));

  expect(calls.find((call) => call.name === "accept_suggestion")?.input).toMatchObject({
    id: 7,
    suggested: { kind: "new", allergens: [] },
  });
});

test("a Suggestion of an existing Item with no Allergens says so plainly: they're the Item's, not the model's", async () => {
  const oil: Suggestion = {
    id: 8,
    text: "beurre",
    suggested: { kind: "existing", item: "olive_oil" },
    suggestedAt: "2026-10-23T12:00:00.000Z",
  };
  await openPage("Resolve Ingredients", { listed: [oil] });

  const beurre = await screen.findByRole("article", { name: "Beurre" });
  const suggestion = await within(beurre).findByRole("region", { name: "Suggestion" });
  expect(within(suggestion).getByText("No Allergens").className).toBe("chip");
  expect(within(suggestion).queryByText("No Allergens suggested")).toBeNull();
});

test("a Suggestion of an existing Item is accepted with another Item a person picked", async () => {
  const { user, calls } = await openPage("Resolve Ingredients");

  const beurre = await screen.findByRole("article", { name: "Beurre" });
  await user.click(await within(beurre).findByRole("button", { name: "Edit" }));
  const item = within(beurre).getByRole<HTMLInputElement>("combobox", { name: "Item" });
  expect(item.value).toBe("butter");
  await user.clear(item);
  await user.type(item, "ghee");
  await user.click(within(beurre).getByRole("button", { name: "Accept" }));

  expect(calls.find((call) => call.name === "accept_suggestion")?.input).toEqual({
    id: 8,
    suggested: { kind: "existing", item: "ghee" },
  });
});

test("Suggest for all asks in batches until no text is left", async () => {
  const { user, calls } = await openPage("Resolve Ingredients", {
    requested: [
      { ok: true, value: { suggestions: [suggestions[0]], remaining: 40 } },
      { ok: true, value: { suggestions: [], remaining: 0 } },
    ],
  });

  const suggestAll = await screen.findByRole("button", { name: "Suggest for all" });
  // A secondary in one bordered block with its status line: the only primaries are each Suggestion's Accept.
  expect(suggestAll.classList.contains("button-secondary")).toBe(true);
  expect(primaries()).toEqual(["Accept", "Accept"]);
  await user.click(suggestAll);

  const status = await screen.findByText("Suggestions made: 1. Every Ingredient has been asked about.");
  expect(suggestAll.closest(".block")).toBeTruthy();
  expect(status.closest(".block")).toBe(suggestAll.closest(".block"));
  expect(calls.filter((call) => call.name === "request_suggestions").map((call) => call.input)).toEqual([{}, {}]);
});

test("Suggest for all says when the model fails, keeping what it already made", async () => {
  const { user } = await openPage("Resolve Ingredients", {
    requested: [
      { ok: true, value: { suggestions: [suggestions[0], suggestions[1]], remaining: 40 } },
      { ok: false, error: { code: "model_failed", message: "" } },
    ],
  });

  await user.click(await screen.findByRole("button", { name: "Suggest for all" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Suggestions made: 2. The model could not make the rest; try again later.",
  );
});

test("a Recipe missing a main protein is tagged in place", async () => {
  const { user, calls } = await openPage("Tag Recipes");

  const bibimbap = await screen.findByRole("form", { name: "Bibimbap" });
  expect(within(bibimbap).getByRole<HTMLInputElement>("textbox", { name: "Cuisine" }).value).toBe("korean");
  await user.type(within(bibimbap).getByRole("textbox", { name: "Main protein" }), " beef ");
  await user.click(within(bibimbap).getByRole("button", { name: "Save" }));

  expect(calls.find((call) => call.name === "update_recipe")?.input).toEqual({
    id: 1,
    cuisine: "korean",
    mainProtein: "beef",
  });
});

test("with every Ingredient resolved, Resolve Ingredients says it is done, with no list", async () => {
  await openPage("Resolve Ingredients", { waiting: { groups: [], untagged } });

  expect(await screen.findByText("Every Ingredient is resolved.")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByRole("button", { name: "Suggest for all" })).toBeNull();
});

test("with every Recipe tagged, Tag Recipes says it is done, with no list", async () => {
  await openPage("Tag Recipes", { waiting: { groups, untagged: [] } });

  expect(await screen.findByText("Every Recipe has a cuisine and a main protein.")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
});
