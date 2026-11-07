import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, onTestFinished, test } from "vitest";
import { type MessageKey, nameText, setLocale, setPseudoLocale, t } from "../src/messages";

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
  const srcDir = join(import.meta.dirname, "../src");
  const source = (file: string) => readFileSync(join(srcDir, file), "utf8");
  const keys = [...source("messages.ts").matchAll(/^\s+"([\w.]+)":/gm)].map(([, key]) => key as string);
  const components = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && file !== "messages.ts")
    .map(source)
    .join("");
  // A key built in a template, such as t(`slot.${kind}`), counts every key under its stem.
  const stems = [...components.matchAll(/`([\w.]+\.)\$\{/g)].map(([, stem]) => stem as string);
  expect(keys.filter((key) => !components.includes(`"${key}"`) && !stems.some((stem) => key.startsWith(stem)))).toEqual(
    [],
  );
});
