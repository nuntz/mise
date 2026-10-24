import { describe, expect, test } from "bun:test";
import { presentTurn } from "./chat";

describe("presentTurn", () => {
  test("names the speaker, the screen and the Week shown", () => {
    const presented = presentTurn({
      speaker: "Robin",
      where: { screen: "week", week: "2026-10-26" },
      text: "re-propose the week but keep Tuesday",
    });

    expect(presented).toBe(
      "[Robin, on the Week screen, showing the Week of Monday 2026-10-26]\nre-propose the week but keep Tuesday",
    );
  });

  test("leaves the Week out when the screen shows none", () => {
    const presented = presentTurn({ speaker: "Sam", where: { screen: "pantry" }, text: "we're out of cumin" });

    expect(presented).toBe("[Sam, on the Pantry screen]\nwe're out of cumin");
  });

  test("says so when no one signed in is speaking", () => {
    const presented = presentTurn({ speaker: null, where: { screen: "recipes" }, text: "hello" });

    expect(presented).toBe("[Someone not signed in, on the Recipes screen]\nhello");
  });
});
