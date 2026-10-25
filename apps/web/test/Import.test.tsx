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

const linkRun: ImportRun = {
  ...today,
  id: 4,
  source: "url",
  created: 1,
  updated: 0,
  skipped: 0,
  flagged: 0,
  errors: [],
};

const pastedRun: ImportRun = {
  ...today,
  id: 3,
  source: "text",
  created: 1,
  updated: 0,
  skipped: 0,
  flagged: 0,
  errors: [],
};

/** A client with one past import that records every upload and tool call made. */
function fakeClient(
  options: {
    upload?: string | null;
    importText?: unknown;
    importUrl?: unknown;
    importScreenshots?: unknown;
    syncDrive?: unknown;
    screenshotUploads?: boolean;
    runs?: ImportRun[];
  } = {},
) {
  const calls: { name: string; input: unknown }[] = [];
  const uploads: Blob[] = [];
  const screenshots: Blob[] = [];
  let runs = options.runs ?? [lastWeek];
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
        case "import_text":
          return options.importText;
        case "import_url":
          return options.importUrl;
        case "import_screenshots":
          return options.importScreenshots;
        case "sync_drive_folder":
          return options.syncDrive;
        case "list_drafts":
        case "list_suggestions":
          return { ok: true, value: [] };
        default:
          throw new Error(`Unexpected tool ${name}`);
      }
    },
    {
      async uploadExport(file) {
        uploads.push(file);
        return options.upload === undefined ? "4b0c6a62-6f1e-4c1a-9d43-2f4d8e5a7b10" : options.upload;
      },
      async uploadScreenshot(file) {
        screenshots.push(file);
        return options.screenshotUploads === false ? null : `upload-${screenshots.length}`;
      },
    },
  );
  /** Logs `run` and announces it, as a Drive sync does when it finishes. */
  const logRun = (run: ImportRun) => {
    runs = [run, ...runs];
    notify("recipes");
  };
  return { client, calls, uploads, screenshots, logRun };
}

const screenshotFiles = () => [
  new File([new Uint8Array([0x89, 0x50])], "ingredients.png", { type: "image/png" }),
  new File([new Uint8Array([0x89, 0x50])], "steps.png", { type: "image/png" }),
];

const screenshotRun: ImportRun = { ...pastedRun, id: 5, source: "screenshot" };

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

test("past imports say what each read, apart from the Paprika import", async () => {
  const { client } = fakeClient({
    importText: { ok: true, value: { run: pastedRun, recipe: { id: 9, title: "Grandma's dal" } } },
  });
  await openImport(client);

  const runs = await screen.findByRole("list", { name: "Past imports" });
  expect(within(runs).getByText(/Paprika: 120 created/)).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Past imports" }).tagName).toBe("H2");
});

test("a pasted recipe's run says it came from pasted text, not Paprika", async () => {
  const { client } = fakeClient({
    importText: { ok: true, value: { run: pastedRun, recipe: { id: 9, title: "Grandma's dal" } } },
    runs: [pastedRun],
  });
  await openImport(client);

  const runs = await screen.findByRole("list", { name: "Past imports" });
  expect(within(runs).getByText(/pasted text: 1 created/)).toBeTruthy();
  expect(within(runs).queryByText(/Paprika/)).toBeNull();
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
    await within(flagged).findByText(
      "Our Toast changed at its source after it was edited or accepted in Mise, so it was left alone.",
    ),
  ).toBeTruthy();
});

test("an upload that fails says so and runs nothing", async () => {
  const { client, calls } = fakeClient({ upload: null });
  await openImport(client);

  await userEvent.upload(await screen.findByLabelText("Paprika export (.paprikarecipes)"), exportFile());

  expect((await screen.findByRole("alert")).textContent).toBe("The export could not be uploaded.");
  expect(calls.map((call) => call.name)).not.toContain("run_paprika_import");
});

test("pasting a recipe's text reads it into a Draft, and goes to the Review screen to check it", async () => {
  const { client, calls } = fakeClient({
    importText: { ok: true, value: { run: pastedRun, recipe: { id: 9, title: "Grandma's dal" } } },
  });
  await openImport(client);

  await userEvent.type(await screen.findByLabelText("Recipe text"), "Grandma's dal{enter}1 cup red lentils");
  await userEvent.click(screen.getByRole("button", { name: "Read the recipe" }));

  expect(calls).toContainEqual({ name: "import_text", input: { text: "Grandma's dal\n1 cup red lentils" } });
  expect((await screen.findByRole("status")).textContent).toBe(
    "Grandma's dal is waiting on the Review screen as a Draft, until someone checks it.",
  );
  expect((screen.getByLabelText("Recipe text") as HTMLTextAreaElement).value).toBe("");
  await userEvent.click(screen.getByRole("button", { name: "Review it" }));
  expect(await screen.findByRole("heading", { name: "Waiting on you" })).toBeTruthy();
});

test("pasted text with no recipe in it says so, and keeps the text", async () => {
  const { client } = fakeClient({
    importText: {
      ok: true,
      value: {
        run: { ...pastedRun, created: 0, errors: [{ entry: null, message: "The text holds no recipe" }] },
        recipe: null,
      },
    },
  });
  await openImport(client);

  await userEvent.type(await screen.findByLabelText("Recipe text"), "Recipe in bio!");
  await userEvent.click(screen.getByRole("button", { name: "Read the recipe" }));

  expect((await screen.findByRole("alert")).textContent).toBe("No recipe was found in that text.");
  expect((screen.getByLabelText("Recipe text") as HTMLTextAreaElement).value).toBe("Recipe in bio!");
});

test("pasted text the model could not read says to try again", async () => {
  const { client } = fakeClient({ importText: { ok: false, error: { code: "model_failed", message: "" } } });
  await openImport(client);

  await userEvent.type(await screen.findByLabelText("Recipe text"), "Grandma's dal");
  await userEvent.click(screen.getByRole("button", { name: "Read the recipe" }));

  expect((await screen.findByRole("alert")).textContent).toBe("The text could not be read just now; try again later.");
});

const DAL_LINK = "https://kitchen.example.com/recipes/red-lentil-dal/";

async function pasteLink(url = DAL_LINK) {
  await userEvent.type(await screen.findByLabelText("Link to a recipe"), url);
  await userEvent.click(screen.getByRole("button", { name: "Import the link" }));
}

test("a pasted link with a recipe Mise can read lands in the Recipes", async () => {
  const { client, calls } = fakeClient({
    importUrl: {
      ok: true,
      value: { run: linkRun, recipe: { id: 11, title: "Red Lentil Dal", draft: false, linkOnly: false } },
    },
  });
  await openImport(client);

  await pasteLink();

  expect(calls).toContainEqual({ name: "import_url", input: { url: DAL_LINK } });
  expect((await screen.findByRole("status")).textContent).toBe("Red Lentil Dal is in your Recipes.");
  expect((screen.getByLabelText("Link to a recipe") as HTMLInputElement).value).toBe("");
});

test("a pasted link the model read waits on the Review screen as a Draft", async () => {
  const { client } = fakeClient({
    importUrl: {
      ok: true,
      value: { run: linkRun, recipe: { id: 12, title: "Shepherd's Pie", draft: true, linkOnly: false } },
    },
  });
  await openImport(client);

  await pasteLink();

  expect((await screen.findByRole("status")).textContent).toBe(
    "Shepherd's Pie is waiting on the Review screen as a Draft, until someone checks it.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Review it" }));
  expect(await screen.findByRole("heading", { name: "Waiting on you" })).toBeTruthy();
});

test("a link Mise could not read is kept, and its recipe's text can be pasted into it", async () => {
  const { client, calls } = fakeClient({
    importUrl: {
      ok: true,
      value: {
        run: { ...linkRun, errors: [{ entry: DAL_LINK, message: "The page was refused by its site (HTTP 403)" }] },
        recipe: { id: 13, title: "Red lentil dal", draft: true, linkOnly: true },
      },
    },
    importText: { ok: true, value: { run: pastedRun, recipe: { id: 13, title: "Red Lentil Dal" } } },
  });
  await openImport(client);

  await pasteLink();

  expect((await screen.findByRole("status")).textContent).toBe(
    "Mise could not read a recipe at that link (The page was refused by its site (HTTP 403)), so it kept the link as a Draft: Red lentil dal. Add screenshots or paste the recipe's text to fill it in.",
  );
  await userEvent.type(screen.getByLabelText("The recipe's text, for Red lentil dal"), "1 cup red lentils");
  await userEvent.click(screen.getByRole("button", { name: "Fill in the Draft" }));
  expect(calls).toContainEqual({ name: "import_text", input: { text: "1 cup red lentils", draft: 13 } });
  expect(
    await screen.findByText("Red Lentil Dal is waiting on the Review screen as a Draft, until someone checks it."),
  ).toBeTruthy();
});

test("a link imported before, and unchanged, says nothing changed", async () => {
  const { client } = fakeClient({
    importUrl: {
      ok: true,
      value: {
        run: { ...linkRun, created: 0, skipped: 1 },
        recipe: { id: 11, title: "Red Lentil Dal", draft: false, linkOnly: false },
      },
    },
  });
  await openImport(client);

  await pasteLink();

  expect((await screen.findByRole("status")).textContent).toBe("Red Lentil Dal is already in Mise, unchanged.");
});

test("a link whose Recipe was edited in Mise since says it was left alone", async () => {
  const { client } = fakeClient({
    importUrl: {
      ok: true,
      value: {
        run: { ...linkRun, created: 0, flagged: 1 },
        recipe: { id: 11, title: "Red Lentil Dal", draft: false, linkOnly: false },
      },
    },
  });
  await openImport(client);

  await pasteLink();

  expect((await screen.findByRole("status")).textContent).toBe(
    "Red Lentil Dal changed at its link, but was edited or accepted in Mise, so it was left alone and flagged.",
  );
});

test("a link imported before that can't be read now says it kept the Recipe, and why", async () => {
  const { client } = fakeClient({
    importUrl: {
      ok: true,
      value: {
        run: {
          ...linkRun,
          created: 0,
          skipped: 1,
          errors: [{ entry: DAL_LINK, message: "The page was refused by its site (HTTP 403)" }],
        },
        recipe: { id: 11, title: "Red Lentil Dal", draft: false, linkOnly: false },
      },
    },
  });
  await openImport(client);

  await pasteLink();

  expect((await screen.findByRole("status")).textContent).toBe(
    "Red Lentil Dal is already in Mise, kept as it was: the link could not be read again (The page was refused by its site (HTTP 403)).",
  );
});

test("screenshots of a recipe are uploaded and read together into a Draft, to check on the Review screen", async () => {
  const { client, calls, screenshots } = fakeClient({
    importScreenshots: { ok: true, value: { run: screenshotRun, recipe: { id: 21, title: "Cabbage Salad" } } },
  });
  await openImport(client);

  await userEvent.upload(await screen.findByLabelText("Screenshots of a recipe"), screenshotFiles());

  expect(
    await screen.findByText("Cabbage Salad is waiting on the Review screen as a Draft, until someone checks it."),
  ).toBeTruthy();
  expect(screenshots.map((file) => (file as File).name)).toEqual(["ingredients.png", "steps.png"]);
  expect(calls).toContainEqual({ name: "import_screenshots", input: { uploads: ["upload-1", "upload-2"] } });
});

test("screenshots that can't be uploaded say so, and nothing is read", async () => {
  const { client, calls } = fakeClient({ screenshotUploads: false });
  await openImport(client);

  await userEvent.upload(await screen.findByLabelText("Screenshots of a recipe"), screenshotFiles());

  expect((await screen.findByRole("alert")).textContent).toBe("The screenshots could not be uploaded.");
  expect(calls.map((call) => call.name)).not.toContain("import_screenshots");
});

test("screenshots with no recipe in them say so", async () => {
  const { client } = fakeClient({
    importScreenshots: { ok: true, value: { run: { ...screenshotRun, created: 0 }, recipe: null } },
  });
  await openImport(client);

  await userEvent.upload(await screen.findByLabelText("Screenshots of a recipe"), screenshotFiles());

  expect((await screen.findByRole("alert")).textContent).toBe("No recipe was found in those screenshots.");
});

test("a link Mise could not read takes screenshots of its recipe, too", async () => {
  const { client, calls } = fakeClient({
    importUrl: {
      ok: true,
      value: {
        run: { ...linkRun, source: "instagram" },
        recipe: { id: 14, title: "Instagram reel", draft: true, linkOnly: true },
      },
    },
    importScreenshots: { ok: true, value: { run: screenshotRun, recipe: { id: 14, title: "Cabbage Salad" } } },
  });
  await openImport(client);
  await pasteLink();

  await userEvent.upload(
    await screen.findByLabelText("Screenshots of the recipe, for Instagram reel"),
    screenshotFiles(),
  );

  expect(calls).toContainEqual({
    name: "import_screenshots",
    input: { uploads: ["upload-1", "upload-2"], draft: 14 },
  });
  expect(
    await screen.findByText("Cabbage Salad is waiting on the Review screen as a Draft, until someone checks it."),
  ).toBeTruthy();
});

test("past imports name TikTok, Instagram and screenshots", async () => {
  const { client } = fakeClient({
    runs: [screenshotRun, { ...linkRun, id: 6, source: "tiktok" }, { ...linkRun, id: 7, source: "instagram" }],
  });
  await openImport(client);

  const runs = await screen.findByRole("list", { name: "Past imports" });
  expect(within(runs).getByText(/screenshots: 1 created/)).toBeTruthy();
  expect(within(runs).getByText(/TikTok: 1 created/)).toBeTruthy();
  expect(within(runs).getByText(/Instagram: 1 created/)).toBeTruthy();
});

const NOTES_DOC = "https://docs.google.com/document/d/1NotesDocId/edit";

const driveRun: ImportRun = {
  ...today,
  id: 6,
  source: "gdrive",
  created: 1,
  updated: 0,
  skipped: 4,
  flagged: 0,
  errors: [{ entry: NOTES_DOC, message: "Shopping notes holds no recipe" }],
};

test("syncing the Drive folder waits for its run, then shows what it did, with a link to each Doc it did not import", async () => {
  const { client, calls, logRun } = fakeClient({ syncDrive: { ok: true, value: { alreadyRunning: false } } });
  await openImport(client);

  await userEvent.click(await screen.findByRole("button", { name: "Sync Drive now" }));

  expect(calls).toContainEqual({ name: "sync_drive_folder", input: {} });
  expect(((await screen.findByRole("button", { name: "Syncing…" })) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();

  // Minutes later, the sync's run is logged and announced.
  logRun(driveRun);

  expect(await screen.findByText("Synced: 1 created, 0 updated, 4 skipped, 0 flagged.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Sync Drive now" })).toBeTruthy();
  const skipped = screen.getByRole("list", { name: "Not imported from Drive" });
  expect(within(skipped).getByRole("link", { name: NOTES_DOC })).toHaveProperty("href", NOTES_DOC);
  expect(within(skipped).getByText(/Shopping notes holds no recipe/)).toBeTruthy();
});

test("syncing says so when the deployment has no Drive folder", async () => {
  const { client } = fakeClient({
    syncDrive: { ok: false, error: { code: "not_configured", message: "No Drive folder is set up for Mise" } },
  });
  await openImport(client);

  await userEvent.click(await screen.findByRole("button", { name: "Sync Drive now" }));

  expect((await screen.findByRole("alert")).textContent).toBe(
    "No Drive folder is set up for Mise. The README says how to connect one.",
  );
});

test("a past Drive sync lists the Docs it did not import, with their links", async () => {
  const { client } = fakeClient({ runs: [driveRun] });
  await openImport(client);

  const runs = await screen.findByRole("list", { name: "Past imports" });
  expect(within(runs).getByText(/Google Drive: 1 created/)).toBeTruthy();
  await userEvent.click(within(runs).getByText("1 not imported"));
  expect(within(runs).getByRole("link", { name: NOTES_DOC })).toHaveProperty("href", NOTES_DOC);
});
