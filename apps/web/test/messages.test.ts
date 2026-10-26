import { afterEach, expect, onTestFinished, test } from "vitest";
import { nameText, setLocale, setPseudoLocale, t } from "../src/messages";

afterEach(() => setPseudoLocale(false));

test("the pseudo-locale is at least 40% longer, bracketed and accented, so clipped or untranslated text shows", () => {
  setPseudoLocale(true);
  const text = t("grocery.rebuild");

  expect(text.startsWith("[")).toBe(true);
  expect(text.endsWith("]")).toBe(true);
  expect(text.length).toBeGreaterThanOrEqual(Math.ceil("Rebuild".length * 1.4));
  expect(text).not.toMatch(/[a-z]/i);
});

test("the pseudo-locale leaves what fills a placeholder as it is", () => {
  setPseudoLocale(true);
  expect(t("recipe.photoAlt", { title: "Pad thai" })).toContain("Pad thai");
});

test("off, messages read as written", () => {
  expect(t("recipe.photoAlt", { title: "Pad thai" })).toBe("Photo of Pad thai");
});

test("a name standing alone takes a capital for the Household's locale, and keeps the rest as stored", () => {
  expect(nameText("cumin")).toBe("Cumin");
  expect(nameText("chicken thigh")).toBe("Chicken thigh");
  expect(nameText("")).toBe("");
  setLocale("tr");
  onTestFinished(() => setLocale("en-CA"));
  expect(nameText("ispanak")).toBe("İspanak");
});
