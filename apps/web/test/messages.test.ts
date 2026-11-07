import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { type MessageKey, nameText, setLocale, setPseudoLocale, t } from "../src/messages";
import { literals, sources } from "./sources";

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

test("Lock is retired (ADR 0030), so no message names it", () => {
  type AboutLock = Extract<MessageKey, `${string}lock${string}` | `${string}Lock${string}`>;
  // Checked when the tests are typechecked: true only while no message key mentions Lock.
  const none: [AboutLock] extends [never] ? true : false = true;
  expect(none).toBe(true);
});

test("a name standing alone takes a capital for the Household's locale, and keeps the rest as stored", () => {
  expect(nameText("cumin")).toBe("Cumin");
  expect(nameText("chicken thigh")).toBe("Chicken thigh");
  expect(nameText("")).toBe("");
  setLocale("tr");
  onTestFinished(() => setLocale("en-CA"));
  expect(nameText("ispanak")).toBe("İspanak");
});

test("every message is shown somewhere, so a screen's removal takes its words with it", () => {
  const messages = readFileSync(join(import.meta.dirname, "../src/messages.ts"), "utf8");
  const keys = [...messages.matchAll(/^\s+"([\w.]+)":/gm)].map(([, key]) => key as string);
  const named = new Set(sources.flatMap(({ code }) => literals(code)));
  // A key built in a template, such as `slot.${kind}.${meal}`, counts the keys with one word for each
  // placeholder: slot.change.dinner, not slot.keep. One that starts with a key built earlier, such as
  // `${key}.term`, counts the keys that end with what follows it.
  const placeholder = /\$\{[^}]*\}/;
  const built = [...named]
    .filter((text) => placeholder.test(text) && /^(?:[a-zA-Z]+|\$\{[^}]*\})\.(?:[\w.]|\$\{[^}]*\})*$/.test(text))
    .map((text) => {
      const parts = text.split(placeholder).map((part) => part.replaceAll(".", "\\."));
      const pattern = text.startsWith("${") ? `[\\w.]+${parts.slice(1).join("\\w+")}` : parts.join("\\w+");
      return new RegExp(`^${pattern}$`);
    });
  expect(keys.filter((key) => !named.has(key) && !built.some((pattern) => pattern.test(key)))).toEqual([]);
});
