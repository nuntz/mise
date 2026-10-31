import { describe, expect, test } from "bun:test";
import { ChatWhere, presentTurn } from "./chat";

describe("presentTurn", () => {
  test("says the day the turn was sent, so “tomorrow” has one meaning", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-27",
      where: { screen: "week", week: "2026-11-02" },
      spoken: false,
      thisWeek: "2026-10-26",
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
      thisWeek: "2026-10-26",
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
      thisWeek: "2026-10-26",
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
      thisWeek: "2026-10-26",
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
      thisWeek: "2026-10-26",
      text: "just the two of us Tuesday",
    });

    expect(presented).toBe(
      "[Robin, speaking on Friday 2026-10-30, on the Week screen, showing the Week of Monday 2026-11-02]\n" +
        "just the two of us Tuesday",
    );
  });

  test("gives a spoken turn from a screen with no Week this Week, never the next", () => {
    const presented = presentTurn({
      speaker: "Robin",
      today: "2026-10-30",
      where: { screen: "pantry" },
      spoken: true,
      thisWeek: "2026-10-26",
      text: "move Tuesday's dinner to Wednesday",
    });

    expect(presented).toBe(
      "[Robin, speaking on Friday 2026-10-30, on the Pantry screen, in the Week of Monday 2026-10-26]\n" +
        "move Tuesday's dinner to Wednesday",
    );
  });
});

describe("ChatWhere", () => {
  test("stays strict: the browser can't mark a turn as spoken", () => {
    expect(ChatWhere.safeParse({ screen: "week", week: "2026-10-26" }).success).toBe(true);
    expect(ChatWhere.safeParse({ screen: "pantry", voice: true }).success).toBe(false);
  });
});
