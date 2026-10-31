import { describe, expect, test } from "bun:test";
import { ChatWhere, presentTurn } from "./chat";
import { parseIngredient } from "./ingredients";

describe("presentTurn", () => {
  test("says the day the turn was sent, so “tomorrow” has one meaning", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-27",
      where: { screen: "week", week: "2026-11-02" },
      spoken: false,
      text: "I won't be eating dinner tomorrow",
    });

    expect(presented).toBe(
      "[Robin, writing on Tuesday 2026-10-27, on the Week screen, showing the Week of Monday 2026-11-02]\n" +
        "I won't be eating dinner tomorrow",
    );
  });

  test("names the speaker, the screen and the Week shown", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-26",
      where: { screen: "week", week: "2026-10-26" },
      spoken: false,
      text: "re-propose the week but keep Tuesday",
    });

    expect(presented).toBe(
      "[Robin, writing on Monday 2026-10-26, on the Week screen, showing the Week of Monday 2026-10-26]\nre-propose the week but keep Tuesday",
    );
  });

  test("leaves the Week out when the screen shows none", () => {
    const presented = presentTurn({
      speaker: "Sam",
      today: "2026-10-26",
      where: { screen: "pantry" },
      spoken: false,
      text: "we're out of cumin",
    });

    expect(presented).toBe("[Sam, writing on Monday 2026-10-26, on the Pantry screen]\nwe're out of cumin");
  });

  test("says so when no one signed in is speaking", () => {
    const presented = presentTurn({
      speaker: null,
      today: "2026-10-26",
      where: { screen: "recipes" },
      spoken: false,
      text: "hello",
    });

    expect(presented).toBe("[Someone not signed in, writing on Monday 2026-10-26, on the Recipes screen]\nhello");
  });

  test("says a spoken turn was spoken, with the Week on screen", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-30",
      where: { screen: "week", week: "2026-11-02" },
      spoken: true,
      text: "just the two of us Tuesday",
    });

    expect(presented).toBe(
      "[Robin, speaking on Friday 2026-10-30, on the Week screen, showing the Week of Monday 2026-11-02; " +
        "answer for the ear: one or two plain sentences, naming at most three things, then ask whether to go on]\n" +
        "just the two of us Tuesday",
    );
  });

  test("gives a spoken turn from a screen with no Week the coming days, so a day passed means next Week's", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-30",
      where: { screen: "pantry" },
      spoken: true,
      text: "move Tuesday's dinner to Wednesday",
    });

    expect(presented).toBe(
      "[Robin, speaking on Friday 2026-10-30, on the Pantry screen, so day names mean the coming days: " +
        "Friday 2026-10-30, Saturday 2026-10-31, Sunday 2026-11-01, Monday 2026-11-02, Tuesday 2026-11-03, " +
        "Wednesday 2026-11-04, Thursday 2026-11-05; " +
        "answer for the ear: one or two plain sentences, naming at most three things, then ask whether to go on]\n" +
        "move Tuesday's dinner to Wednesday",
    );
  });

  test("after a turn left unanswered, says to answer only this one", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-30",
      where: { screen: "pantry" },
      spoken: false,
      afterUnanswered: true,
      text: "we're out of cumin",
    });

    expect(presented).toBe(
      "[Robin, writing on Friday 2026-10-30, on the Pantry screen; " +
        "Mise couldn't answer the messages before this one: answer only this message]\n" +
        "we're out of cumin",
    );
  });

  test("says so with a spoken turn too, after how to answer for the ear", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-30",
      where: { screen: "week", week: "2026-10-26" },
      spoken: true,
      afterUnanswered: true,
      text: "next step",
    });

    expect(presented).toBe(
      "[Robin, speaking on Friday 2026-10-30, on the Week screen, showing the Week of Monday 2026-10-26; " +
        "answer for the ear: one or two plain sentences, naming at most three things, then ask whether to go on; " +
        "Mise couldn't answer the messages before this one: answer only this message]\n" +
        "next step",
    );
  });
});

describe("presentTurn in Kitchen mode", () => {
  const satay = {
    title: "Satay",
    baseServings: 4,
    readyMade: false,
    ingredients: ["2 cloves garlic", "400 g chicken"].map((line) => parseIngredient(line)),
    steps: ["Marinate the chicken.", "Thread onto skewers.", "Grill for 8 minutes."],
  };

  test("names the Recipe, its Slot, the step on screen, and gives its steps and Ingredients scaled to the Slot", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-11-03",
      where: { screen: "kitchen", recipe: 1, slot: { date: "2026-11-03", meal: "dinner" }, step: 2 },
      cooking: { recipe: satay, servings: 6, locale: "en-CA" },
      spoken: true,
      text: "how much garlic",
    });

    const [header, steps, ingredients, text] = presented.split("\n");
    expect(header).toMatch(
      /^\[Robin, speaking on Tuesday 2026-11-03, in Kitchen mode, cooking Satay for the dinner of Tuesday 2026-11-03, for 6 servings, showing step 2 of 3, so day names mean .*; answer for the ear: .*\]$/,
    );
    expect(steps).toBe("[Satay's steps: 1. Marinate the chicken. 2. Thread onto skewers. 3. Grill for 8 minutes.]");
    expect(ingredients).toBe(
      "[Satay's Ingredients for 6 servings, as Kitchen mode shows them: 3 cloves garlic; 600 g chicken]",
    );
    expect(text).toBe("how much garlic");
  });

  test("cooked from the Recipe's page, gives its Ingredients at its own servings", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-11-03",
      where: { screen: "kitchen", recipe: 1, step: 1 },
      cooking: { recipe: satay, servings: 4, locale: "en-CA" },
      spoken: true,
      text: "how much garlic",
    });

    expect(presented).toMatch(/, in Kitchen mode, cooking Satay as written, for 4 servings, showing step 1 of 3, /);
    expect(presented).toMatch(
      /\n\[Satay's Ingredients for 4 servings, as Kitchen mode shows them: 2 cloves garlic; 400 g chicken\]\n/,
    );
  });

  test("says only Kitchen mode when the Recipe is gone", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-11-03",
      where: { screen: "kitchen", recipe: 1, step: 1 },
      spoken: false,
      text: "next step",
    });

    expect(presented).toBe("[Robin, writing on Tuesday 2026-11-03, in Kitchen mode]\nnext step");
  });
});

describe("ChatWhere", () => {
  test("stays strict: the browser can't mark a turn as spoken", () => {
    expect(ChatWhere.safeParse({ screen: "week", week: "2026-10-26" }).success).toBe(true);
    expect(ChatWhere.safeParse({ screen: "pantry", voice: true }).success).toBe(false);
    expect(ChatWhere.safeParse({ screen: "kitchen", recipe: 1, step: 1, spoken: true }).success).toBe(false);
  });

  test("carries Kitchen mode's Recipe, Slot and step, and no Week", () => {
    expect(
      ChatWhere.safeParse({ screen: "kitchen", recipe: 1, slot: { date: "2026-11-03", meal: "dinner" }, step: 2 })
        .success,
    ).toBe(true);
    expect(ChatWhere.safeParse({ screen: "kitchen", recipe: 1 }).success).toBe(true);
    expect(ChatWhere.safeParse({ screen: "kitchen", recipe: 1, step: 0 }).success).toBe(false);
    expect(ChatWhere.safeParse({ screen: "kitchen", week: "2026-10-26" }).success).toBe(false);
  });
});
