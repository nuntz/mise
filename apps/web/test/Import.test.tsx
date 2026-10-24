import { DEFAULT_EFFORT_BUDGETS, type Household, type ImportFlag, type ImportRun, STORE_SECTIONS } from "@mise/domain";
import { render, screen, within } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { App } from "../src/App";
import type { MiseClient } from "../src/client";
import { createFakeClient } from "./fakeClient";

const household: Household = {
  name: "The Tremblays",
  timezone: "America/Vancouver",
  dinnerTime: "18:00",
  weekStartsOn: "monday",
  weekStartChanges: [],
  units: "metric",
  locale: "en-CA",
  members: [],
  effortBudgets: DEFAULT_EFFORT_BUDGETS,
  storeSections: [...STORE_SECTIONS],
};

const lastWeek: ImportRun = {
  id: 1,
  source: "paprika",
  startedAt: "2026-10-14T19:00:00.000Z",
  created: 120,
  updated: 0,
  skipped: 2,
  flagged: 1,
  errors: [],
};

const today: ImportRun = {
  id: 2,
  source: "paprika",
  startedAt: "2026-10-21T19:00:00.000Z",
  created: 1,
  updated: 3,
  skipped: 118,
  flagged: 1,
  errors: [{ entry: "Broken.paprikarecipe", message: "The file is not JSON" }],
};

const flags: ImportFlag[] = [
  {
    id: 2,
    runId: 2,
    kind: "merge",
    recipe: { id: 7, title: "Our Toast" },
    duplicateOf: null,
    flaggedAt: today.startedAt,
  },
  {
    id: 1,
    runId: 1,
    kind: "duplicate",
    recipe: { id: 5, title: "Weeknight Dal" },
    duplicateOf: { id: 2, title: "Weeknight dal!" },
    flaggedAt: lastWeek.startedAt,
  },
];

/** A client with one past import that records every upload and tool call made. */
function fakeClient(options: { upload?: string | null } = {}) {
  const calls: { name: string; input: unknown }[] = [];
  const uploads: Blob[] = [];
  let runs = [lastWeek];
  const { client, notify } = createFakeClient(
    async (name: string, input: unknown) => {
      calls.push({ name, input });
      switch (name) {
        case "get_household":
          return { ok: true, value: household };
        case "search_recipes":
          return { ok: true, value: [] };
        case "list_import_runs":
          return { ok: true, value: runs };
        case "list_import_flags":
          return { ok: true, value: runs.length > 1 ? flags : flags.slice(1) };
        case "run_paprika_import":
          runs = [today, lastWeek];
          // The change notice that follows a run.
          queueMicrotask(() => notify("recipes"));
          return { ok: true, value: today };
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    },
    {
      async uploadExport(file) {
        uploads.push(file);
        return options.upload === undefined ? "4b0c6a62-6f1e-4c1a-9d43-2f4d8e5a7b10" : options.upload;
      },
    },
  );
  return { client, calls, uploads };
}

async function openImport(client: MiseClient) {
  render(() => <App client={client} />);
  await userEvent.click(await screen.findByRole("button", { name: "Household" }));
  await userEvent.click(await screen.findByRole("button", { name: "Import" }));
}

const exportFile = () => new File([new Uint8Array([0x50, 0x4b, 5, 6])], "My Recipes.paprikarecipes");

test("lists past imports and what they flagged", async () => {
  const { client } = fakeClient();

  await openImport(client);

  const runs = await screen.findByRole("list", { name: "Past imports" });
  expect(within(runs).getByText(/120 created, 0 updated, 2 skipped, 1 flagged/)).toBeTruthy();
  const flagged = screen.getByRole("list", { name: "Flagged Recipes" });
  expect(within(flagged).getByText("Weeknight Dal may be the same as Weeknight dal!. Both are kept.")).toBeTruthy();
});

test("importing a Paprika export uploads it, runs the import and shows what it did", async () => {
  const { client, calls, uploads } = fakeClient();
  await openImport(client);

  await userEvent.upload(await screen.findByLabelText("Paprika export (.paprikarecipes)"), exportFile());

  expect(await screen.findByRole("status")).toHaveProperty(
    "textContent",
    "Imported: 1 created, 3 updated, 118 skipped, 1 flagged.",
  );
  expect(uploads.map((file) => (file as File).name)).toEqual(["My Recipes.paprikarecipes"]);
  expect(calls).toContainEqual({
    name: "run_paprika_import",
    input: { upload: "4b0c6a62-6f1e-4c1a-9d43-2f4d8e5a7b10" },
  });
  const errors = screen.getByRole("list", { name: "Not imported" });
  expect(within(errors).getByText("Broken.paprikarecipe: The file is not JSON")).toBeTruthy();
  const flagged = screen.getByRole("list", { name: "Flagged Recipes" });
  expect(
    await within(flagged).findByText("Our Toast changed in Paprika, but was edited in Mise, so it was left alone."),
  ).toBeTruthy();
});

test("an upload that fails says so and runs nothing", async () => {
  const { client, calls } = fakeClient({ upload: null });
  await openImport(client);

  await userEvent.upload(await screen.findByLabelText("Paprika export (.paprikarecipes)"), exportFile());

  expect((await screen.findByRole("alert")).textContent).toBe("The export could not be uploaded.");
  expect(calls.map((call) => call.name)).not.toContain("run_paprika_import");
});
