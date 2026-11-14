import type { ChangeNotice, ChangeTopic, RecipeId } from "@mise/domain";
import { createRoot } from "solid-js";
import { expect, onTestFinished, test } from "vitest";
import type { MiseClient } from "../src/client";
import { keepFresh } from "../src/fresh";
import { createFakeClient } from "./fakeClient";

/**
 * A household whose answers wait until the test lets them go, so notices can land while loads are in
 * flight. Counts the calls that reach it by tool name, and answers each with its name and call number.
 */
function slowHousehold() {
  const calls = new Map<string, number>();
  const waiting: Array<() => void> = [];
  const fake = createFakeClient((name) => {
    const count = (calls.get(name) ?? 0) + 1;
    calls.set(name, count);
    return new Promise((resolve) => waiting.push(() => resolve(`${name} #${count}`)));
  });
  return {
    ...fake,
    calls: (name: string) => calls.get(name) ?? 0,
    /** Answers every call waiting, then lets the loads that follow them start. */
    async answer() {
      for (const answer of waiting.splice(0)) answer();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

/** Keeps `name` fresh on `topics`, as a screen would, and returns what it showed. */
function subscribe(client: MiseClient, name: string, topics: readonly ChangeTopic[], input = () => ({})) {
  const shown: unknown[] = [];
  const failed: unknown[] = [];
  let refetch!: () => Promise<void>;
  createRoot((dispose) => {
    onTestFinished(dispose);
    refetch = keepFresh(
      client,
      topics,
      () => client.call(name as "get_week", input()),
      (value) => shown.push(value),
      (error) => failed.push(error),
    );
  });
  return { shown, failed, refetch: () => refetch() };
}

test("a burst of notices costs each subscriber the load in flight and one more, not a load per notice", async () => {
  const household = slowHousehold();
  subscribe(household.client, "get_grocery_list", ["recipes"]);
  subscribe(household.client, "list_items", ["recipes"]);
  subscribe(household.client, "list_drafts", ["recipes"]);
  const subscribers = ["get_grocery_list", "list_items", "list_drafts"];
  expect(subscribers.map(household.calls)).toEqual([1, 1, 1]);

  for (let i = 0; i < 20; i++) household.notify("recipes");
  expect(subscribers.map(household.calls)).toEqual([1, 1, 1]);

  await household.answer();
  expect(subscribers.map(household.calls)).toEqual([2, 2, 2]);

  await household.answer();
  expect(subscribers.map(household.calls)).toEqual([2, 2, 2]);
});

test("a notice that comes once the load has answered loads again", async () => {
  const household = slowHousehold();
  const list = subscribe(household.client, "get_grocery_list", ["grocery"]);
  await household.answer();
  household.notify("grocery");
  await household.answer();
  household.notify("grocery");
  await household.answer();

  expect(household.calls("get_grocery_list")).toBe(3);
  expect(list.shown).toEqual(["get_grocery_list #1", "get_grocery_list #2", "get_grocery_list #3"]);
});

test("only the latest load shows, so an answer overtaken by a notice or a new input never does", async () => {
  const household = slowHousehold();
  let week = "this";
  const shown = subscribe(household.client, "get_week", ["plan"], () => ({ week }));
  week = "next";
  const loaded = shown.refetch();
  household.notify("plan");
  await household.answer();
  await household.answer();
  await loaded;

  expect(household.calls("get_week")).toBe(2);
  expect(shown.shown).toEqual(["get_week #2"]);
});

test("a load that fails while another is wanted says nothing, and the next one answers", async () => {
  const answers: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  const fake = createFakeClient(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
  const list = subscribe(fake.client, "get_grocery_list", ["grocery"]);
  fake.notify("grocery");
  answers[0]?.reject(new Error("Durable Object is overloaded"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  answers[1]?.resolve("the list");
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(list.failed).toEqual([]);
  expect(list.shown).toEqual(["the list"]);
});

test("a refetch asked for while a load is in flight resolves once its own load has answered", async () => {
  const household = slowHousehold();
  const list = subscribe(household.client, "get_grocery_list", ["grocery"]);
  let settled = false;
  const loaded = list.refetch().then(() => {
    settled = true;
  });
  await household.answer();
  expect(settled).toBe(false);
  await household.answer();
  await loaded;

  expect(list.shown).toEqual(["get_grocery_list #2"]);
});

/**
 * Keeps Recipes fresh as the offline keepers do, wanting only the notices `wanted` takes, and returns
 * which Recipes each load was asked for: those named, or "all".
 */
function keepRecipes(client: MiseClient, wanted?: (notice: ChangeNotice) => boolean) {
  const asked: Array<RecipeId[] | "all"> = [];
  createRoot((dispose) => {
    onTestFinished(dispose);
    keepFresh(
      client,
      ["recipes", "plan"],
      (named) => {
        asked.push(named ? [...named].sort((a, b) => a - b) : "all");
        return client.call("get_recipe", { id: 1 });
      },
      () => {},
      () => {},
      { wanted },
    );
  });
  return asked;
}

test("a notice it doesn't want loads nothing, unless it lands while a load is in flight", async () => {
  const household = slowHousehold();
  const asked = keepRecipes(household.client, (notice) => notice.recipes?.includes(3) ?? true);
  await household.answer();

  household.notify("recipes", [7]);
  expect(household.calls("get_recipe")).toBe(1);

  household.notify("recipes", [3]);
  household.notify("recipes", [7]);
  await household.answer();
  await household.answer();

  // The load in flight may have read Recipe 7 before it changed.
  expect(asked).toEqual(["all", [3], [3, 7]]);
});

test("a load is asked for the Recipes named in the notices it answers, and for all on any other", async () => {
  const household = slowHousehold();
  const asked = keepRecipes(household.client);
  await household.answer();

  household.notify("recipes", [7]);
  household.notify("recipes", [8]);
  household.notify("recipes", [9]);
  await household.answer();
  await household.answer();

  household.notify("recipes", [1]);
  household.notify("recipes");
  await household.answer();
  await household.answer();

  household.notify("recipes", [1]);
  household.notify("plan");
  await household.answer();
  await household.answer();

  household.goOffline();
  household.goOnline();
  await household.answer();

  // The load in flight is overtaken, so the one after answers its notice as well as those since.
  expect(asked).toEqual(["all", [7], [7, 8, 9], [1], "all", [1], "all", "all"]);
});

test("a load that fails leaves what it was asked for to the next", async () => {
  const answers: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  const fake = createFakeClient(() => new Promise((resolve, reject) => answers.push({ resolve, reject })));
  const asked = keepRecipes(fake.client);
  const answered = () => new Promise((resolve) => setTimeout(resolve, 0));
  answers[0]?.resolve("loaded");
  await answered();

  fake.notify("recipes");
  answers[1]?.reject(new Error("Durable Object is overloaded"));
  await answered();
  fake.notify("recipes", [7]);
  answers[2]?.resolve("loaded");
  await answered();
  fake.notify("recipes", [8]);

  expect(asked).toEqual(["all", "all", "all", [8]]);
});
