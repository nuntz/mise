/**
 * Screenshots the Week for the README: builds the PWA, runs `wrangler dev` on a fresh, throwaway
 * store, seeds the fictional sample Household and its Week, and saves what a phone shows to
 * docs/screenshots/. Nothing is committed: look the images over, then commit the ones to keep.
 * With `--screens`, saves every screen instead, as a phone shows it a screenful at a time, in
 * daylight, kitchen mode and the pseudo-locale, to dist/screens/ (never committed), for a design review.
 * Usage: bun run screenshot [--screens]. Needs Playwright's Chromium once: bunx playwright install chromium.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUSEHOLD_AGENT, type Week } from "@mise/domain";
import { AgentClient } from "agents/client";
import { type Browser, chromium, devices, type Page } from "playwright";
import sampleHousehold from "../../../fixtures/sample-household.json";
import sampleWeek from "../../../fixtures/sample-week.json";

// Away from `bun run dev`'s 8787, so a local deployment can keep running alongside.
const PORT = 8797;
const host = `localhost:${PORT}`;
const repo = join(import.meta.dir, "../../..");
const out = join(repo, "docs/screenshots");
const screensOut = join(repo, "dist/screens");
const everyScreen = process.argv.includes("--screens");

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`${command.join(" ")} failed`);
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
 * Unresolved Ingredients, a link-only Draft to review, Staples due and run low, and a Grocery List.
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
  // A link Mise can't read becomes a link-only Draft; without a reachable model it may refuse instead.
  try {
    await call(agent, "import_url", { url: "https://recipes.example.invalid/grandmas-dumplings" });
  } catch (error) {
    console.warn(`No Draft to review: ${error}`);
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
}

async function screenshot(browser: Browser) {
  const context = await browser.newContext({ ...devices["iPhone 15"], colorScheme: "light" });
  const page = await context.newPage();
  await page.goto(`http://${host}/`);
  const firstDinner = page.getByText(sampleWeek.dinners[0]?.recipe ?? "").first();
  await firstDinner.waitFor();
  // Fonts and the Week's last fetch settle.
  await page.waitForLoadState("networkidle");
  // The dinners, not the controls above them: Monday's photo at the top of the screen.
  const box = await firstDinner.boundingBox();
  if (box) await page.evaluate((y) => window.scrollTo(0, y), box.y - 210);
  await page.screenshot({ path: join(out, "week-phone.png") });
  console.log(`Saved ${join(out, "week-phone.png")}`);
}

/** The Household page's settings, in the order of its chips (App.tsx's SETTINGS). */
const SETTINGS = ["members", "settings", "calendar", "notifications", "review", "import", "resolve", "items", "tag"];

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
};

function screens(ids: Map<string, number>): Screen[] {
  const recipe = ids.get(sampleWeek.dinners[0]?.recipe ?? "");
  const nav = (index: number) => (page: Page) => page.locator("nav.nav button").nth(index).click();
  const header = (index: number) => (page: Page) => page.locator(".app-header .button-row").nth(index).click();
  return [
    { name: "week" },
    { name: "week-dinner", open: (page) => page.locator(".dish-open").first().click(), overlay: true },
    { name: "week-next", path: "/?week=next" },
    { name: "week-offline", open: (page) => page.context().setOffline(true) },
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
    { name: "grocery", open: nav(2) },
    { name: "pantry", path: "/?pantry" },
    ...SETTINGS.map((setting, index) => ({
      name: `household-${setting}`,
      path: "/?review",
      open: (page: Page) => page.locator("nav.chips button").nth(index).click(),
    })),
  ];
}

/** Daylight, kitchen mode, and the long pseudo-locale. */
const VARIANTS = [
  { name: "daylight", query: "", kitchen: false },
  { name: "kitchen", query: "", kitchen: true },
  { name: "pseudo", query: "pseudo", kitchen: false },
];

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
  const screenfuls = screen.overlay ? 1 : Math.min(MAX_SCREENFULS, Math.ceil(scroll / view));
  for (let index = 0; index < screenfuls; index++) {
    await page.evaluate((y) => window.scrollTo(0, y), index * view);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${base}-${index + 1}.png` });
  }
}

async function screenshotEveryScreen(browser: Browser, ids: Map<string, number>) {
  for (const variant of VARIANTS) {
    const dir = join(screensOut, variant.name);
    await mkdir(dir, { recursive: true });
    for (const [index, screen] of screens(ids).entries()) {
      const context = await phone(browser, variant);
      const page = await context.newPage();
      const base = join(dir, `${String(index + 1).padStart(2, "0")}-${screen.name}`);
      try {
        await capture(page, screen, variant.query, base);
      } catch (error) {
        console.warn(`${variant.name}/${screen.name} not saved: ${error}`);
      } finally {
        await context.close();
      }
    }
  }
  console.log(`Saved every screen to ${screensOut}`);
}

/** The first-run setup form, from a Household not set up yet. */
async function screenshotSetup(browser: Browser) {
  for (const variant of VARIANTS) {
    await mkdir(join(screensOut, variant.name), { recursive: true });
    const context = await phone(browser, variant);
    await capture(
      await context.newPage(),
      { name: "setup" },
      variant.query,
      join(screensOut, variant.name, "00-setup"),
    );
    await context.close();
  }
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
  { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "inherit" },
);
try {
  await waitForWorker();
  const browser = await chromium.launch();
  try {
    if (everyScreen) await screenshotSetup(browser);
    const ids = await seed();
    if (everyScreen) await screenshotEveryScreen(browser, ids);
    else await screenshot(browser);
  } finally {
    await browser.close();
  }
} finally {
  worker.kill();
  await worker.exited;
  await rm(store, { recursive: true, force: true });
}
