/**
 * Screenshots the Week for the README: builds the PWA, runs `wrangler dev` on a fresh, throwaway
 * store, seeds the fictional sample Household and its Week, and saves what a phone shows to
 * docs/screenshots/. Nothing is committed: look the images over, then commit the ones to keep.
 * Usage: bun run screenshot. Needs Playwright's Chromium once: bunx playwright install chromium.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUSEHOLD_AGENT, type Week } from "@mise/domain";
import { AgentClient } from "agents/client";
import { chromium, devices } from "playwright";
import sampleHousehold from "../../../fixtures/sample-household.json";
import sampleWeek from "../../../fixtures/sample-week.json";

// Away from `bun run dev`'s 8787, so a local deployment can keep running alongside.
const PORT = 8797;
const host = `localhost:${PORT}`;
const repo = join(import.meta.dir, "../../..");
const out = join(repo, "docs/screenshots");

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
async function seed() {
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
  } finally {
    agent.close();
  }
}

async function screenshot() {
  const browser = await chromium.launch();
  try {
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
  } finally {
    await browser.close();
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
  await seed();
  await screenshot();
  console.log(`Saved ${join(out, "week-phone.png")}`);
} finally {
  worker.kill();
  await worker.exited;
  await rm(store, { recursive: true, force: true });
}
