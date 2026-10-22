import { env } from "cloudflare:workers";
import type { Recipe, ToolResult } from "@mise/domain";
import { describe, expect, onTestFinished, test } from "vitest";

function freshHousehold() {
  return env.Household.getByName(crypto.randomUUID());
}

async function setUpHousehold() {
  const household = freshHousehold();
  await household.callTool("setup_household", { name: "The Example Family" });
  return household;
}

/** The Recipe a tool call that is expected to succeed returned. */
function recipeOf(result: ToolResult<unknown>): Recipe {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as Recipe;
}

const pancakes = {
  title: "Pancakes",
  baseServings: 4,
  ingredients: ["1 1/2 cups flour", "2 large eggs", "1 ¼ cups milk", "2 tbsp butter, melted"],
  steps: ["Whisk everything together.", "Fry in a hot pan."],
  tags: ["breakfast"],
};

describe("hand-entered Recipes", () => {
  test("a created Recipe can be read back, its Ingredients parsed", async () => {
    const household = await setUpHousehold();

    const created = await household.callTool("create_recipe", pancakes);
    const read = await household.callTool("get_recipe", { id: 1 });

    const expected = {
      id: 1,
      title: "Pancakes",
      baseServings: 4,
      ingredients: [
        {
          raw: "1 1/2 cups flour",
          amount: { min: 1.5, max: 1.5 },
          unit: "cup",
          name: "flour",
          note: null,
          item: "flour",
        },
        { raw: "2 large eggs", amount: { min: 2, max: 2 }, unit: null, name: "large eggs", note: null, item: "egg" },
        { raw: "1 ¼ cups milk", amount: { min: 1.25, max: 1.25 }, unit: "cup", name: "milk", note: null, item: "milk" },
        {
          raw: "2 tbsp butter, melted",
          amount: { min: 2, max: 2 },
          unit: "tbsp",
          name: "butter",
          note: "melted",
          item: "butter",
        },
      ],
      steps: ["Whisk everything together.", "Fry in a hot pan."],
      tags: ["breakfast"],
      effortMinutes: null,
      cuisine: null,
      mainProtein: null,
      recurring: null,
      yieldsLeftovers: false,
      prepAhead: null,
      notes: null,
      photoKey: null,
      allergens: { kind: "known", allergens: ["milk", "egg", "wheat"] },
      source: { kind: "manual" },
      importedPreference: null,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      editedInAppAt: null,
    };
    expect(created).toEqual({ ok: true, value: expected });
    expect(read).toEqual({ ok: true, value: expected });
  });

  test("a Recipe needs a title, base servings and its Ingredient lines", async () => {
    const household = await setUpHousehold();

    const result = await household.callTool("create_recipe", { title: " ", ingredients: [] });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_input", issues: [{ path: "title" }, { path: "baseServings" }] },
    });
  });

  test("blank lines are dropped and tags are kept once, in lower case", async () => {
    const household = await setUpHousehold();

    const created = await household.callTool("create_recipe", {
      ...pancakes,
      ingredients: ["2 eggs", "  ", ""],
      steps: ["", "Fry."],
      tags: ["Breakfast", "breakfast", " Quick "],
    });

    expect(created).toMatchObject({
      ok: true,
      value: { ingredients: [{ raw: "2 eggs" }], steps: ["Fry."], tags: ["breakfast", "quick"] },
    });
  });

  test("every field of a Recipe is kept", async () => {
    const household = await setUpHousehold();
    const fields = {
      effortMinutes: 25,
      cuisine: "Canadian",
      mainProtein: "egg",
      recurring: { weekday: "sunday" },
      yieldsLeftovers: true,
      prepAhead: "Mix the dry ingredients the night before.",
      notes: "From Grandma's card.",
    };

    await household.callTool("create_recipe", { ...pancakes, ...fields });

    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true, value: fields });
  });

  test("reading a Recipe that doesn't exist is refused", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("get_recipe", { id: 9 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("a Recipe's effective Allergens", () => {
  test("are the union over its Ingredients' Items, hidden sources included", async () => {
    const household = await setUpHousehold();

    const created = await household.callTool("create_recipe", {
      title: "Stir-fry",
      baseServings: 4,
      ingredients: ["2 tbsp soy sauce", "1 tbsp fish sauce", "1 tsp sesame oil", "1 lb shrimp", "2 cups rice"],
    });

    expect(created).toMatchObject({
      ok: true,
      value: { allergens: { kind: "known", allergens: ["wheat", "soy", "fish", "shellfish", "sesame"] } },
    });
  });

  test("are none when no Ingredient carries one", async () => {
    const household = await setUpHousehold();

    const created = await household.callTool("create_recipe", {
      title: "Rice",
      baseServings: 2,
      ingredients: ["1 cup rice", "2 cups water", "salt"],
    });

    expect(created).toMatchObject({ ok: true, value: { allergens: { kind: "known", allergens: [] } } });
  });

  test("are unknown while any Ingredient is Unresolved, failing closed", async () => {
    const household = await setUpHousehold();

    const created = await household.callTool("create_recipe", {
      title: "Toast",
      baseServings: 2,
      ingredients: ["2 slices bread", "1 tbsp butter", "1 tbsp mystery spread"],
    });

    expect(created).toMatchObject({
      ok: true,
      value: {
        ingredients: [{ item: null }, { item: "butter" }, { item: null }],
        allergens: { kind: "unknown", atLeast: ["milk"], unresolved: 2 },
      },
    });
  });

  test("change when the Ingredients are edited", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { title: "Toast", baseServings: 2, ingredients: ["2 slices bread"] });

    const updated = await household.callTool("update_recipe", { id: 1, ingredients: ["1 tbsp tahini", "1 lemon"] });

    expect(updated).toMatchObject({ ok: true, value: { allergens: { kind: "known", allergens: ["sesame"] } } });
  });
});

describe("editing and deleting Recipes", () => {
  test("editing a Recipe changes only the fields given", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", { ...pancakes, effortMinutes: 20 });

    const updated = await household.callTool("update_recipe", { id: 1, title: "Fluffy pancakes", effortMinutes: null });

    const expected = { ...pancakes, title: "Fluffy pancakes", effortMinutes: null };
    const { ingredients: _, ...rest } = expected;
    expect(updated).toMatchObject({ ok: true, value: { ...rest, ingredients: [{ item: "flour" }, {}, {}, {}] } });
    expect(await household.callTool("get_recipe", { id: 1 })).toEqual(updated);
  });

  test("editing a Recipe moves its updated time, not its created time", async () => {
    const household = await setUpHousehold();
    const created = await household.callTool("create_recipe", pancakes);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await household.callTool("update_recipe", { id: 1, tags: [] });

    expect(recipeOf(updated).createdAt).toBe(recipeOf(created).createdAt);
    expect(recipeOf(updated).updatedAt > recipeOf(created).updatedAt).toBe(true);
  });

  test("editing a Recipe records when it was edited in Mise", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);

    const updated = recipeOf(await household.callTool("update_recipe", { id: 1, notes: "Use buttermilk." }));

    expect(updated).toMatchObject({ notes: "Use buttermilk.", editedInAppAt: updated.updatedAt });
  });

  test("editing a Recipe that doesn't exist is refused", async () => {
    const household = await setUpHousehold();

    expect(await household.callTool("update_recipe", { id: 9, title: "Nothing" })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  test("deleting a Recipe needs confirmation", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);

    const refused = await household.callTool("delete_recipe", { id: 1 });

    expect(refused).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "confirm" }] } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({ ok: true });
  });

  test("a deleted Recipe is gone, and its id is not handed out again", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);

    const deleted = await household.callTool("delete_recipe", { id: 1, confirm: true });
    const again = await household.callTool("create_recipe", pancakes);

    expect(deleted).toMatchObject({ ok: true, value: { id: 1, title: "Pancakes" } });
    expect(await household.callTool("get_recipe", { id: 1 })).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(again).toMatchObject({ ok: true, value: { id: 2, ingredients: [{}, {}, {}, {}] } });
    expect(await household.callTool("search_recipes", {})).toMatchObject({ ok: true, value: [{ id: 2 }] });
  });
});

describe("searching Recipes", () => {
  async function withRecipes() {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);
    await household.callTool("create_recipe", {
      title: "Garlic noodles",
      baseServings: 2,
      ingredients: ["200 g spaghetti", "6 cloves garlic", "4 green onions, sliced"],
      tags: ["quick", "vegetarian"],
    });
    await household.callTool("create_recipe", {
      title: "Chili",
      baseServings: 6,
      ingredients: ["1 lb ground beef", "1 can kidney beans", "2 tbsp chili powder"],
      tags: ["batch"],
      effortMinutes: 90,
    });
    return household;
  }

  const titles = (result: unknown) => (result as { value: { title: string }[] }).value.map((recipe) => recipe.title);

  test("with no query lists every Recipe by title", async () => {
    const household = await withRecipes();

    const result = await household.callTool("search_recipes", {});

    expect(titles(result)).toEqual(["Chili", "Garlic noodles", "Pancakes"]);
    expect(result).toMatchObject({
      ok: true,
      value: [
        {
          id: 3,
          title: "Chili",
          tags: ["batch"],
          effortMinutes: 90,
          cuisine: null,
          mainProtein: null,
          allergens: { kind: "known", allergens: [] },
          photoKey: null,
        },
        {},
        {},
      ],
    });
  });

  test("finds Recipes by title, ignoring case", async () => {
    const household = await withRecipes();

    expect(titles(await household.callTool("search_recipes", { query: "NOODLE" }))).toEqual(["Garlic noodles"]);
  });

  test("finds Recipes by tag", async () => {
    const household = await withRecipes();

    expect(titles(await household.callTool("search_recipes", { query: "vegetarian" }))).toEqual(["Garlic noodles"]);
    expect(titles(await household.callTool("search_recipes", { tag: "Batch" }))).toEqual(["Chili"]);
  });

  test("finds Recipes by Ingredient, as written or by its Item", async () => {
    const household = await withRecipes();

    expect(titles(await household.callTool("search_recipes", { query: "kidney" }))).toEqual(["Chili"]);
    expect(titles(await household.callTool("search_recipes", { query: "eggs" }))).toEqual(["Pancakes"]);
    expect(titles(await household.callTool("search_recipes", { query: "scallions" }))).toEqual(["Garlic noodles"]);
  });

  test("combines a query with a tag", async () => {
    const household = await withRecipes();

    expect(titles(await household.callTool("search_recipes", { query: "garlic", tag: "batch" }))).toEqual([]);
    expect(titles(await household.callTool("search_recipes", { query: "garlic", tag: "quick" }))).toEqual([
      "Garlic noodles",
    ]);
  });
});

describe("tagging Recipes", () => {
  test("lists the Recipes missing a cuisine or main protein, in title order, until both are set", async () => {
    const household = await setUpHousehold();
    const recipe = { baseServings: 2, ingredients: ["1 cup rice"] };
    await household.callTool("create_recipe", { ...recipe, title: "Tacos", cuisine: "mexican" });
    await household.callTool("create_recipe", { ...recipe, title: "Dal", cuisine: "indian", mainProtein: "lentils" });
    await household.callTool("create_recipe", { ...recipe, title: "Bibimbap" });

    const before = await household.callTool("list_untagged_recipes", {});
    await household.callTool("update_recipe", { id: 1, mainProtein: "beef" });
    const after = await household.callTool("list_untagged_recipes", {});

    expect(before).toMatchObject({
      ok: true,
      value: [
        { id: 3, title: "Bibimbap", cuisine: null, mainProtein: null },
        { id: 1, title: "Tacos", cuisine: "mexican", mainProtein: null },
      ],
    });
    expect(after).toMatchObject({ ok: true, value: [{ id: 3, title: "Bibimbap" }] });
  });
});

describe("change notices", () => {
  test("a connected client is told when Recipes change", async () => {
    const household = await setUpHousehold();
    const notice = await nextNotice(household);

    await household.callTool("create_recipe", pancakes);

    expect(await notice.next).toEqual({ type: "mise:change", topic: "recipes", revision: 2 });
  });
});

describe("Recipe photos", () => {
  const photoUrl = (id: number) => `http://mise.example.com/agents/household/household/recipes/${id}/photo`;
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  function putPhoto(household: ReturnType<typeof freshHousehold>, id: number, body: BodyInit, type = "image/jpeg") {
    return household.fetch(photoUrl(id), { method: "PUT", headers: { "Content-Type": type }, body });
  }

  async function photoKeyOf(household: ReturnType<typeof freshHousehold>, id = 1) {
    return recipeOf(await household.callTool("get_recipe", { id })).photoKey;
  }

  test("a photo is stored in R2 and served back", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);

    const response = await putPhoto(household, 1, jpeg);

    expect(response.status).toBe(200);
    const key = await photoKeyOf(household);
    expect(key).toMatch(/^photos\/recipe-1-/);
    onTestFinished(() => env.BUCKET.delete(key as string));
    expect(new Uint8Array(await ((await env.BUCKET.get(key as string)) as R2ObjectBody).arrayBuffer())).toEqual(jpeg);
    const served = await household.fetch(photoUrl(1));
    expect(served.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg);
  });

  test("a new photo replaces the old one in R2", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);
    await putPhoto(household, 1, jpeg);
    const first = await photoKeyOf(household);

    await putPhoto(household, 1, new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");

    const second = await photoKeyOf(household);
    onTestFinished(() => env.BUCKET.delete(second as string));
    expect(second).not.toBe(first);
    expect(await env.BUCKET.head(first as string)).toBeNull();
    expect((await household.fetch(photoUrl(1))).headers.get("Content-Type")).toBe("image/png");
  });

  test("a photo can be removed", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);
    await putPhoto(household, 1, jpeg);
    const key = await photoKeyOf(household);

    const response = await household.fetch(photoUrl(1), { method: "DELETE" });

    expect(response.status).toBe(200);
    expect(await photoKeyOf(household)).toBeNull();
    expect(await env.BUCKET.head(key as string)).toBeNull();
    expect((await household.fetch(photoUrl(1))).status).toBe(404);
  });

  test("deleting a Recipe deletes its photo", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);
    await putPhoto(household, 1, jpeg);
    const key = await photoKeyOf(household);

    await household.callTool("delete_recipe", { id: 1, confirm: true });

    expect(await env.BUCKET.head(key as string)).toBeNull();
  });

  test("only images are accepted", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);

    const response = await putPhoto(household, 1, "<script>", "text/html");

    expect(response.status).toBe(415);
    expect(await photoKeyOf(household)).toBeNull();
  });

  test("a photo for a Recipe that doesn't exist is refused", async () => {
    const household = await setUpHousehold();

    expect((await putPhoto(household, 7, jpeg)).status).toBe(404);
    expect((await household.fetch(photoUrl(7))).status).toBe(404);
  });

  test("a connected client is told when a photo changes", async () => {
    const household = await setUpHousehold();
    await household.callTool("create_recipe", pancakes);
    const notice = await nextNotice(household);

    await putPhoto(household, 1, jpeg);

    onTestFinished(async () => env.BUCKET.delete((await photoKeyOf(household)) as string));
    expect(await notice.next).toEqual({ type: "mise:change", topic: "recipes", revision: 3 });
  });
});

/** Opens a WebSocket to the household; `next` resolves with the first change notice it receives. */
async function nextNotice(household: ReturnType<typeof freshHousehold>) {
  const response = await household.fetch("http://mise.example.com/agents/household/household", {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`Expected a WebSocket upgrade, got ${response.status}`);
  socket.accept();
  const next = new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "mise:change") resolve(message);
    });
  });
  return { next };
}
