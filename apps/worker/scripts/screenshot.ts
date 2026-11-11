/**
 * Screenshots the Week for the README: builds the PWA, runs `wrangler dev` on a fresh, throwaway
 * store, seeds the fictional sample Household and its Week (its `photographed` Recipes with
 * fixtures/photos/sample-dish.jpg), and saves what a phone shows to
 * docs/screenshots/. Nothing is committed: look the images over, then commit the ones to keep.
 * With `--screens`, saves every screen instead, as a phone shows it a screenful at a time, in
 * daylight, kitchen mode and the pseudo-locale, to dist/screens/ (never committed), for a design review.
 * `--only week,import` takes just the screens whose names contain one of those words, and `--variants
 * daylight` just those variants, to retake a screen quickly while working on it. Each screen
 * records the web source it was taken from, and `--check` lists the screens taken before the source
 * last changed, or never taken, without starting anything.
 * A screen that fails is skipped in the variants after it, and the run ends listing every failure and
 * exiting 1.
 * Usage: bun run screenshot [--screens [--only <words>] [--variants <names>] | --check].
 * Needs Playwright's Chromium once: bunx playwright install chromium.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDays, HOUSEHOLD_AGENT, recipePhotoPath, type Week } from "@mise/domain";
import { AgentClient } from "agents/client";
import { type Browser, chromium, devices, type Locator, type Page } from "playwright";
import sampleHousehold from "../../../fixtures/sample-household.json";
import sampleWeek from "../../../fixtures/sample-week.json";

// Away from `bun run dev`'s 8787, so a local deployment can keep running alongside.
const PORT = 8797;
const host = `localhost:${PORT}`;
const repo = join(import.meta.dir, "../../..");
const out = join(repo, "docs/screenshots");
const screensOut = join(repo, "dist/screens");

// Anything else, `--help` included, prints the usage and takes nothing: a mistyped flag would otherwise
// retake the README's screenshot over the committed one.
const USAGE = "Usage: bun run screenshot [--screens [--only <words>] [--variants <names>] | --check]";
const VALUED = ["--only", "--variants"];
const args = process.argv.slice(2);
const unknownArg = args.find(
  (arg, index) => ![...VALUED, "--screens", "--check"].includes(arg) && !VALUED.includes(args[index - 1] ?? ""),
);
if (unknownArg !== undefined) {
  console.error(unknownArg === "--help" ? USAGE : `Unknown argument ${unknownArg}. ${USAGE}`);
  process.exit(unknownArg === "--help" ? 0 : 2);
}

const everyScreen = process.argv.includes("--screens");
/** The comma-separated values after `flag`, or none. */
function listArg(flag: string): string[] {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? "").split(",").filter(Boolean) : [];
}
const only = listArg("--only");
const wanted = (name: string) => only.length === 0 || only.some((word) => name.includes(word));

/** Which web source each screen was last taken from, by screen name. */
const takenFile = join(screensOut, "taken.json");

/** A hash of every file under apps/web/src, so a screen taken from older source shows as stale. */
function webSource(): string {
  const src = join(repo, "apps/web/src");
  const hash = createHash("sha256");
  for (const file of readdirSync(src, { recursive: true, encoding: "utf8" }).sort()) {
    try {
      hash.update(file).update(readFileSync(join(src, file)));
    } catch {} // a directory
  }
  return hash.digest("hex").slice(0, 16);
}

async function readTaken(): Promise<Record<string, string>> {
  const file = Bun.file(takenFile);
  return (await file.exists()) ? file.json() : {};
}

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`);
}

/**
 * Passes `wrangler dev`'s errors on, less the one the seed causes on purpose: the DNS failure of the
 * link it imports from a host that never resolves, and the stack line under it. Any later one shows.
 */
async function passOnErrors(stderr: ReadableStream<Uint8Array>) {
  let expected = true;
  let underIt = false;
  let rest = "";
  const decoder = new TextDecoder();
  const reader = stderr.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const lines = (rest + decoder.decode(read.value, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (expected && line.includes("failed to lookup address information")) {
        [expected, underIt] = [false, true];
        continue;
      }
      // workerd puts a blank line between the error and its stack.
      if (underIt && (line.trim() === "" || line.trimStart().startsWith("stack:"))) continue;
      underIt = false;
      process.stderr.write(`${line}\n`);
    }
  }
  if (rest) process.stderr.write(rest);
}

async function waitForWorker() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`http://${host}/`)).ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`wrangler dev never answered on ${host}`);
}

async function call(agent: AgentClient, name: string, input: unknown) {
  const result = (await agent.call("callTool", [name, input])) as
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string } };
  if (!result.ok) throw new Error(`${name}: ${result.error.code}: ${result.error.message}`);
  return result.value;
}

/** The sample Household, its Recipes, and this Week's dinners from fixtures/sample-week.json. */
async function seed(): Promise<Map<string, number>> {
  const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host });
  try {
    await call(agent, "setup_household", sampleHousehold);
    const ids = new Map<string, number>();
    for (const recipe of sampleWeek.recipes) {
      const created = (await call(agent, "create_recipe", recipe)) as { id: number };
      ids.set(recipe.title, created.id);
    }
    // Some dinners photographed and some not, so the screens show a dish's photo and its placeholder.
    const photo = Bun.file(join(repo, "fixtures/photos/sample-dish.jpg"));
    for (const title of sampleWeek.photographed) {
      const id = ids.get(title);
      if (id === undefined) throw new Error(`No sample Recipe ${title} to photograph`);
      const response = await fetch(`http://${host}${recipePhotoPath(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: photo,
      });
      if (!response.ok) throw new Error(`Photographing ${title}: ${response.status}`);
    }
    const week = (await call(agent, "get_week", {})) as Week;
    const dates = [...new Set(week.slots.map((slot) => slot.date))];
    for (const dinner of sampleWeek.dinners) {
      const slot = { date: dates[dinner.day], meal: "dinner" };
      if (dinner.recipe) {
        await call(agent, "set_slot", { ...slot, kind: "recipe", recipeId: ids.get(dinner.recipe) });
      } else if (dinner.eatOut) {
        await call(agent, "set_slot", { ...slot, kind: "eat_out", note: dinner.eatOut });
      } else if (dinner.leftovers !== undefined) {
        await call(agent, "set_slot", { ...slot, kind: "leftovers" });
        await call(agent, "link_leftovers", { ...slot, of: { date: dates[dinner.leftovers], meal: "dinner" } });
      }
    }
    if (everyScreen) await seedTheRest(agent, ids);
    return ids;
  } finally {
    agent.close();
  }
}

/**
 * What the screens past the Week need to show more than their empty states: a Recipe with
 * Unresolved Ingredients and, given a model, Suggestions for them, a Recipe to tag, a link-only
 * Draft to review, Staples due and run low, a Grocery List, a calendar link and a Kitchen Display;
 * this Week proposed with every dinner the Household's own, so Re-roll is disabled and says why; and
 * next Week, a Ready-made dish after a Monday of Leftovers whose form reaches back into this Week, then
 * pencilled dinners for the rest, using up broccoli and apples.
 */
async function seedTheRest(agent: AgentClient, ids: Map<string, number>) {
  const resolving = (await call(agent, "create_recipe", {
    title: "Shiso Rice Bowls",
    baseServings: 2,
    effortMinutes: 20,
    cuisine: "japanese",
    mainProtein: "egg",
    ingredients: ["2 cups sushi rice", "1 bunch shiso", "2 tbsp furikake", "4 eggs", "a knob of pickled ginger"],
    steps: ["Cook the rice.", "Fry the eggs.", "Top the rice with eggs, shiso and furikake."],
  })) as { id: number };
  ids.set("Shiso Rice Bowls", resolving.id);
  // A Recipe with no main protein, for Tag Recipes to list.
  await call(agent, "create_recipe", {
    title: "Tomato Soup",
    baseServings: 4,
    effortMinutes: 30,
    cuisine: "american",
    ingredients: ["2 cans whole tomatoes", "1 onion", "2 cups vegetable stock"],
    steps: ["Soften the onion.", "Simmer with the tomatoes and stock, then blend."],
  });
  // A link Mise can't read becomes a link-only Draft; without a reachable model it may refuse instead.
  // Its host never resolves, and the error workerd logs for that is the one `passOnErrors` leaves out.
  try {
    await call(agent, "import_url", { url: "https://recipes.example.invalid/grandmas-dumplings" });
  } catch (error) {
    console.warn(`No Draft to review: ${error}`);
  }
  // Suggestions for the Unresolved Ingredients need a model; without one, Resolve shows none.
  try {
    await call(agent, "request_suggestions", {});
  } catch (error) {
    console.warn(`No Suggestions to review: ${error}`);
  }
  for (const [item, location] of [
    ["cumin", "pantry"],
    ["olive_oil", "pantry"],
    ["rice", "pantry"],
    ["milk", "fridge"],
    ["butter", "fridge"],
  ] as const) {
    await call(agent, "upsert_staple", { item, location });
  }
  await call(agent, "record_staple_status", { item: "milk", status: "low" });
  await call(agent, "build_grocery_list", {});
  await call(agent, "rotate_calendar_token", {});
  await call(agent, "add_kitchen_display", { label: "Kitchen counter" });
  // Its Allergens are none the sample Members avoid, so its Slot has no Conflict to override.
  const readyMade = (await call(agent, "create_ready_made_recipe", READY_MADE)) as { id: number };
  ids.set(READY_MADE.title, readyMade.id);
  const thisWeek = (await call(agent, "get_week", {})) as Week;
  const next = addDays(thisWeek.startDate, 7);
  await call(agent, "set_slot", { date: next, meal: "dinner", kind: "leftovers" });
  await call(agent, "set_slot", {
    date: addDays(next, 1),
    meal: "dinner",
    kind: "recipe",
    recipeId: readyMade.id,
  });
  // Proposing a Week chosen entirely by hand changes no dinner.
  await call(agent, "propose_week", { date: thisWeek.startDate });
  await call(agent, "set_use_up", { date: next, items: ["broccoli", "apple"] });
  await call(agent, "propose_week", { date: next });
}

/** The Ready-made dish seeded, whose product the add-dish form then finds already an Item. */
const READY_MADE = {
  title: "Frozen Dumplings",
  product: "frozen vegetable dumplings",
  baseServings: 4,
  allergens: ["wheat", "soy", "sesame"],
  section: "frozen",
  steps: ["Steam from frozen for 12 minutes."],
  effortMinutes: 5,
  yieldsLeftovers: true,
};

async function screenshot(browser: Browser) {
  const context = await browser.newContext({ ...devices["iPhone 15"], colorScheme: "light" });
  const page = await context.newPage();
  await page.goto(`http://${host}/`);
  const firstDinner = page.getByText(sampleWeek.dinners[0]?.recipe ?? "").first();
  await firstDinner.waitFor();
  // Fonts and the Week's last fetch settle.
  await page.waitForLoadState("networkidle");
  // From the top: the Week's title and controls are short enough to show with its first dinners.
  await page.screenshot({ path: join(out, "week-phone.png") });
  console.log(`Saved ${join(out, "week-phone.png")}`);
}

/** The Import page's ways to import, in the order of its rows (Import.tsx's IMPORT_METHODS). */
const IMPORT_METHODS = ["link", "paste", "screenshots", "paprika", "drive"];

/** The Household page's settings, in the order of its rows (App.tsx's SETTING_GROUPS). */
const SETTINGS = [
  "members",
  "settings",
  "calendar",
  "displays",
  "notifications",
  "review",
  "import",
  "resolve",
  "items",
  "tag",
];

/**
 * Every screen, each opened from a fresh page by its link and then by position, not by label, so
 * the pseudo-locale opens the same ones.
 */
type Screen = {
  name: string;
  path?: string;
  open?: (page: Page) => Promise<void>;
  /** A sheet or kitchen mode over the page: one screenful, as scrolling moves what's underneath. */
  overlay?: boolean;
  /** The part of a long page to show: one screenful, from its top. */
  focus?: (page: Page) => Locator;
};

function screens(ids: Map<string, number>): Screen[] {
  const recipe = ids.get(sampleWeek.dinners[0]?.recipe ?? "");
  const nav = (index: number) => (page: Page) => page.locator("nav.nav button").nth(index).click();
  const header = (index: number) => (page: Page) => page.locator(".app-header .button-row").nth(index).click();
  // The add-dish form, its title and product filled in.
  const readyMadeForm = (title: string, product: string) => async (page: Page) => {
    await nav(1)(page);
    // The list's second button: the first adds a Recipe.
    await page.locator("main button.button-secondary").nth(1).click();
    await page.locator("form input").nth(0).fill(title);
    await page.locator("form input").nth(1).fill(product);
  };
  // From the product's field, so the banner under it shows with what it's about.
  const productField = (page: Page) => page.locator("form label").nth(1);
  // Next Week's Monday, of Leftovers, and its Slot form.
  const nextMonday = (page: Page) => page.locator("section.day").first().locator("section.slot").first();
  // A dinner with a Recipe, opened, and its sheet's last row: Edit, after Keep and Mark as cooked.
  const editDinner = (slot: (page: Page) => Locator) => async (page: Page) => {
    await slot(page).locator(".dish-open").first().click();
    await page.locator(".sheet button.button-row").last().click();
  };
  // The first of next Week's pencilled dinners that Keep is offered for, and the first with a Recipe, by its Cook.
  const keepable = (page: Page) => page.locator("section.slot:has(.chip-plum):has(.slot-keep)").first();
  const keepableRecipe = (page: Page) =>
    page.locator("section.slot:has(.chip-plum):has(.slot-keep):has(.slot-cook)").first();
  // A dinner marked Ready-made: the chip beside its day that is neither Pencilled nor a Conflict.
  const readyMade = (page: Page) =>
    page.locator("section.slot:has(.slot-day .chip:not(.chip-plum):not(.chip-warn))").first();
  // The Week's controls, from its title down.
  const weekControls = (page: Page) => page.locator(".week-screen .page-header");
  const openUseUp = (page: Page) => page.locator(".proposal-use-up").click();
  return [
    { name: "week" },
    { name: "week-dinner", open: (page) => page.locator(".dish-open").first().click(), overlay: true },
    { name: "week-next", path: "/?week=next" },
    { name: "week-offline", open: (page) => page.context().setOffline(true) },
    {
      name: "week-day-open",
      // The first day's breakfast and lunch unfolded, from the top of that day.
      open: (page) => page.locator("section.day .strip-plan").first().click(),
      focus: (page) => page.locator("section.day").first(),
    },
    {
      name: "week-effort",
      open: (page) => page.locator(".effort-budgets > summary").click(),
      focus: (page) => page.locator(".effort-budgets"),
    },
    { name: "ran-out", open: header(0), overlay: true },
    { name: "chat", open: header(1), overlay: true },
    { name: "recipes", open: nav(1) },
    { name: "recipe", path: `/?recipe=${recipe}` },
    { name: "recipe-resolving", path: `/?recipe=${ids.get("Shiso Rice Bowls")}` },
    {
      name: "kitchen",
      path: `/?recipe=${recipe}`,
      open: (page) => page.locator(".page button.button-primary").first().click(),
      overlay: true,
    },
    {
      name: "kitchen-update",
      path: `/?recipe=${recipe}`,
      // A newer build taking over while cooking: the first claim is the first install, the second a newer build.
      open: async (page) => {
        await page.locator(".page button.button-primary").first().click();
        await page.evaluate(() => {
          for (let claim = 0; claim < 2; claim++) navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
        });
      },
      overlay: true,
    },
    { name: "recipes-ready-made-new", open: readyMadeForm("Frozen Pierogi", "frozen potato pierogi") },
    {
      name: "recipes-ready-made-known",
      open: readyMadeForm("Dumpling Night", READY_MADE.product),
      focus: productField,
    },
    {
      name: "recipes-ready-made-weighed",
      open: readyMadeForm("Grilled Chicken", "chicken breasts"),
      focus: productField,
    },
    {
      name: "recipes-ready-made-leftovers",
      open: async (page) => {
        await readyMadeForm("Frozen Pierogi", "frozen potato pierogi")(page);
        await page.locator('form input[type="checkbox"]').last().check();
      },
      // From the field above it, so the box shows with the buttons under it.
      focus: (page) => page.locator('form input[type="number"]').last(),
    },
    {
      name: "recipes-ready-made-chip",
      open: nav(1),
      focus: (page) => page.locator(".recipe-row:has(.chip:not(.chip-amber))").first(),
    },
    { name: "recipe-ready-made", path: `/?recipe=${ids.get(READY_MADE.title)}` },
    {
      name: "week-cook-for-leftovers",
      // From the title of the Wednesday cooked for Thursday's Leftovers, so the two show together.
      focus: (page) => page.locator("section.slot", { hasText: sampleWeek.dinners[2]?.recipe ?? "" }).locator(".dish"),
    },
    {
      name: "week-next-ready-made",
      path: "/?week=next",
      focus: readyMade,
    },
    {
      name: "week-next-ready-made-sheet",
      path: "/?week=next",
      open: (page) => readyMade(page).locator(".dish-open").click(),
      overlay: true,
    },
    {
      name: "week-next-leftovers-of",
      path: "/?week=next",
      open: async (page) => {
        // Change dinner, after Keep when the Leftovers are pencilled.
        await nextMonday(page).locator("button.button-row").last().click();
        // Its meals from the Week before arrive a moment after the form opens.
        const list = page.locator(".slot-form select").filter({ has: page.locator('option[value*="/"]') });
        await list.waitFor();
        // A select's list is drawn by the system, which a screenshot leaves out: shown in the page instead.
        await list.evaluate((select: HTMLSelectElement) => {
          select.size = select.options.length;
        });
      },
      overlay: true,
    },
    { name: "week-kept", focus: weekControls },
    {
      name: "week-kept-form",
      open: editDinner((page) => page.locator("section.slot").first()),
      overlay: true,
    },
    {
      name: "week-kept-choose-recipe",
      // Choose a Recipe, opened from the Slot form's Recipe field, once the Recipes have arrived.
      open: async (page) => {
        await editDinner((page) => page.locator("section.slot").first())(page);
        await page.locator(".recipe-field").click();
        await page.locator(".recipe-picker .row-open").first().waitFor();
      },
      overlay: true,
    },
    { name: "week-next-keep", path: "/?week=next", focus: keepable },
    { name: "week-next-pencilled-form", path: "/?week=next", open: editDinner(keepableRecipe), overlay: true },
    { name: "week-next-use-up", path: "/?week=next", open: openUseUp, overlay: true },
    {
      name: "week-next-use-up-unchanged",
      path: "/?week=next",
      // Saved as it was, the Use it up changes no dinner.
      open: async (page) => {
        await openUseUp(page);
        await page.locator(".sheet .button-primary").click();
        await page.locator(".page-header p.banner-plum").waitFor();
      },
      focus: weekControls,
    },
    { name: "grocery", open: nav(2) },
    { name: "pantry", path: "/?pantry" },
    { name: "household", open: nav(4) },
    ...SETTINGS.map((setting, index) => ({
      name: `household-${setting}`,
      open: async (page: Page) => {
        await nav(4)(page);
        await page.locator("button.row-open").nth(index).click();
      },
    })),
    ...IMPORT_METHODS.map((method, index) => ({
      name: `household-import-${method}`,
      open: async (page: Page) => {
        await nav(4)(page);
        await page.locator("button.row-open").nth(SETTINGS.indexOf("import")).click();
        await page.locator("button.row-open").nth(index).click();
      },
    })),
    {
      name: "household-resolve-create",
      open: async (page: Page) => {
        await nav(4)(page);
        await page.locator("button.row-open").nth(SETTINGS.indexOf("resolve")).click();
        // The first group with a name: a blank one has no buttons. Its second is Create an Item.
        await page.locator(".rows .row-end").first().locator("button").nth(1).click();
      },
    },
    {
      name: "household-member-edit",
      open: async (page: Page) => {
        await nav(4)(page);
        await page.locator("button.row-open").first().click();
        await page.locator(".rows .row-end button").first().click();
      },
    },
  ];
}

/** Daylight, kitchen mode, and the long pseudo-locale. */
const VARIANTS = [
  { name: "daylight", query: "", kitchen: false },
  { name: "kitchen", query: "", kitchen: true },
  { name: "pseudo", query: "pseudo", kitchen: false },
];

/** The variants to take: those `--variants` names, or all three. */
const variantNames = listArg("--variants");
const unknownVariant = variantNames.find((name) => !VARIANTS.some((variant) => variant.name === name));
if (unknownVariant) throw new Error(`No variant ${unknownVariant}: ${VARIANTS.map((v) => v.name).join(", ")}`);
const variants = VARIANTS.filter((variant) => variantNames.length === 0 || variantNames.includes(variant.name));

/** A phone in daylight, kept in kitchen mode for that variant as the Household page's switch keeps it. */
async function phone(browser: Browser, variant: (typeof VARIANTS)[number]) {
  const context = await browser.newContext({ ...devices["iPhone 15"], colorScheme: "light" });
  if (variant.kitchen) await context.addInitScript(() => localStorage.setItem("mise.kitchenMode", "on"));
  return context;
}

/** Screenfuls past this are left out: the Items page lists the whole catalogue. */
const MAX_SCREENFULS = 6;

/**
 * Opens the screen's path (with the variant's query), lets it settle, and saves it a screenful at a
 * time as `<base>-1.png`, `<base>-2.png`…
 */
async function capture(page: Page, screen: Screen, query: string, base: string) {
  const url = new URL(screen.path ?? "/", `http://${host}`);
  if (query) url.searchParams.set(query, "");
  await page.goto(url.toString());
  await page.locator("main").first().waitFor();
  await page.waitForTimeout(1500);
  if (screen.open) {
    await screen.open(page);
    await page.waitForTimeout(1000);
  }
  const { scroll, view } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollHeight,
    view: window.innerHeight,
  }));
  if (screen.focus) {
    await screen
      .focus(page)
      .first()
      .evaluate((element) => {
        element.scrollIntoView({ block: "start" });
        window.scrollBy(0, -24);
      });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${base}-1.png` });
    return;
  }
  const screenfuls = screen.overlay ? 1 : Math.min(MAX_SCREENFULS, Math.ceil(scroll / view));
  for (let index = 0; index < screenfuls; index++) {
    await page.evaluate((y) => window.scrollTo(0, y), index * view);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${base}-${index + 1}.png` });
  }
}

/** Saves every wanted screen in each variant taken; returns the ones not saved, as "variant/screen: error". */
async function screenshotEveryScreen(browser: Browser, ids: Map<string, number>): Promise<string[]> {
  const taken = await readTaken();
  const source = webSource();
  const failures: string[] = [];
  // A screen that failed once fails the same way in every variant: its wait would only time out again.
  const failed = new Set<string>();
  for (const variant of variants) {
    const dir = join(screensOut, variant.name);
    await mkdir(dir, { recursive: true });
    for (const [index, screen] of screens(ids).entries()) {
      if (!wanted(screen.name) || failed.has(screen.name)) continue;
      const context = await phone(browser, variant);
      const page = await context.newPage();
      const base = join(dir, `${String(index + 1).padStart(2, "0")}-${screen.name}`);
      try {
        await capture(page, screen, variant.query, base);
        taken[`${variant.name}/${screen.name}`] = source;
      } catch (error) {
        failed.add(screen.name);
        failures.push(`${variant.name}/${screen.name}: ${error}`);
      } finally {
        await context.close();
      }
    }
  }
  await Bun.write(takenFile, JSON.stringify(taken, null, 2));
  const which = only.length > 0 ? `the screens matching ${only.join(", ")}` : "every screen";
  console.log(`Saved ${failures.length > 0 ? `the rest of ${which}` : which} to ${screensOut}`);
  return failures;
}

/** Lists the screens taken from older web source than now, or never taken, and fails if there are any. */
async function checkScreens() {
  const taken = await readTaken();
  const source = webSource();
  const names = ["setup", ...screens(new Map()).map((screen) => screen.name)];
  const stale = VARIANTS.flatMap((variant) =>
    names.map((name) => `${variant.name}/${name}`).filter((key) => taken[key] !== source),
  );
  if (stale.length === 0) {
    console.log("Every screen in dist/screens shows the current web source.");
    return;
  }
  console.error(`Taken before the web source last changed, or never taken (${stale.length}):`);
  for (const key of stale) console.error(`  ${key}`);
  console.error("Retake them with: bun run screenshot --screens --only <words>");
  process.exit(1);
}

/** The first-run setup form, from a Household not set up yet. */
async function screenshotSetup(browser: Browser) {
  if (!wanted("setup")) return;
  const taken = await readTaken();
  for (const variant of variants) {
    await mkdir(join(screensOut, variant.name), { recursive: true });
    const context = await phone(browser, variant);
    await capture(
      await context.newPage(),
      { name: "setup" },
      variant.query,
      join(screensOut, variant.name, "00-setup"),
    );
    await context.close();
    taken[`${variant.name}/setup`] = webSource();
  }
  await mkdir(screensOut, { recursive: true });
  await Bun.write(takenFile, JSON.stringify(taken, null, 2));
}

if (process.argv.includes("--check")) {
  await checkScreens();
  process.exit(0);
}

const store = await mkdtemp(join(tmpdir(), "mise-screenshot-"));
await run(["bun", "run", "--filter", "@mise/web", "build"], repo);
const worker = Bun.spawn(
  [
    "bunx",
    "wrangler",
    "dev",
    "--port",
    String(PORT),
    "--persist-to",
    store,
    "--var",
    "DEV_CALLER_EMAIL:cook@example.com",
  ],
  { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "pipe" },
);
void passOnErrors(worker.stderr);
let failures: string[] = [];
try {
  await waitForWorker();
  const browser = await chromium.launch();
  try {
    if (everyScreen) await screenshotSetup(browser);
    const ids = await seed();
    if (everyScreen) failures = await screenshotEveryScreen(browser, ids);
    else await screenshot(browser);
  } finally {
    await browser.close();
  }
} finally {
  worker.kill();
  await worker.exited;
  await rm(store, { recursive: true, force: true });
}
if (failures.length > 0) {
  console.error(`Not saved (${failures.length}):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
