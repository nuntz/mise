import { env } from "cloudflare:workers";
import {
  type Draft,
  FakeLlm,
  HOUSEHOLD_PATH,
  type ImportFlag,
  type ImportRun,
  type Recipe,
  type RecipeReading,
  type ToolResult,
} from "@mise/domain";
import { exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { SAMPLE_JPEG, utf8, zip } from "../../../fixtures/paprika";
import { googleDrive, type ServiceAccountKey, useDrive } from "../src/drive";
import { useLlm } from "../src/llm";
import { usePush, webPush } from "../src/push";
import { newDevice, pretendPushService, subscriptionOf, vapidKey } from "./pushService";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

const HOUSEHOLD_URL = `https://mise.example.com${HOUSEHOLD_PATH}`;
const FOLDER = "0BxRecipeInbox";
const SERVICE_ACCOUNT = "mise-drive@example.com";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

/** A file in the pretend Drive: a folder, a Doc with its exports, or anything else. */
type PretendFile = {
  id: string;
  name: string;
  mimeType: string;
  parent: string;
  modifiedTime: string;
  trashed?: boolean;
  markdown?: string;
  zippedHtml?: Uint8Array<ArrayBuffer>;
};

let key: ServiceAccountKey;
let verifyKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  verifyKey = pair.publicKey;
  key = { client_email: SERVICE_ACCOUNT, private_key: await exportPKCS8(pair.privateKey) };
});

/**
 * Google's token endpoint and the Drive API, as far as the sync uses them, over `files`: the folder
 * shared with the service account and what is in it. The token endpoint checks the service account's
 * signed assertion, and Drive the token it handed out. Returns the Docs exported, as `id:mimeType`.
 */
function pretendGoogle(files: PretendFile[], shared = true): string[] {
  const exported: string[] = [];
  const TOKEN = "ya29.pretend-token";
  useDrive(() =>
    googleDrive(key, FOLDER, async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(new TextDecoder().decode(await request.arrayBuffer()));
        const { payload } = await jwtVerify(form.get("assertion") ?? "", verifyKey, {
          issuer: SERVICE_ACCOUNT,
          audience: "https://oauth2.googleapis.com/token",
        });
        expect(payload.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
        return Response.json({ access_token: TOKEN, expires_in: 3599, token_type: "Bearer" });
      }
      if (request.headers.get("Authorization") !== `Bearer ${TOKEN}`) return new Response(null, { status: 401 });
      const visible = (id: string) => shared && (id === FOLDER || files.some((file) => file.id === id));
      const path = url.pathname.replace("/drive/v3/files", "");
      if (path === "") {
        const query = url.searchParams.get("q") ?? "";
        const parent = /^'([^']+)' in parents and trashed = false/.exec(query)?.[1];
        const types = [...query.matchAll(/mimeType = '([^']+)'/g)].map(([, type]) => type);
        const children = files.filter(
          (file) => visible(file.id) && file.parent === parent && !file.trashed && types.includes(file.mimeType),
        );
        // One file a page, so that every listing is paged as a long one is.
        const at = Number(url.searchParams.get("pageToken") ?? 0);
        const page = children.slice(at, at + 1);
        return Response.json({
          files: page.map(({ id, name, mimeType, modifiedTime }) => ({ id, name, mimeType, modifiedTime })),
          ...(at + 1 < children.length && { nextPageToken: String(at + 1) }),
        });
      }
      const [id, action] = path.slice(1).split("/") as [string, string | undefined];
      if (!action && url.searchParams.get("supportsAllDrives") !== "true") {
        // As Drive answers for a folder in a shared drive, unless asked to look in shared drives.
        return Response.json({ error: { code: 404, message: "File not found" } }, { status: 404 });
      }
      if (!visible(id)) return Response.json({ error: { code: 404, message: "File not found" } }, { status: 404 });
      if (!action) return Response.json({ id, mimeType: FOLDER_MIME });
      const file = files.find((candidate) => candidate.id === id) as PretendFile;
      const mimeType = url.searchParams.get("mimeType");
      exported.push(`${id}:${mimeType}`);
      if (mimeType === "text/markdown") return new Response(file.markdown, { headers: { "Content-Type": mimeType } });
      if (mimeType === "application/zip" && file.zippedHtml) return new Response(file.zippedHtml);
      return Response.json({ error: { code: 400, message: "Export not supported" } }, { status: 400 });
    }),
  );
  return exported;
}

const SOUP_MARKDOWN = "# Grandma's Lentil Soup\n\n* 1 cup red lentils\n* 1 onion, diced\n\nSimmer for 30 minutes.";

const soupDoc = (changes: Partial<PretendFile> = {}): PretendFile => ({
  id: "1SoupDocId",
  name: "Lentil soup",
  mimeType: DOC_MIME,
  parent: FOLDER,
  modifiedTime: "2026-10-20T08:15:00.000Z",
  markdown: SOUP_MARKDOWN,
  ...changes,
});

const soup: RecipeReading = {
  isRecipe: true,
  title: "Grandma's Lentil Soup",
  ingredients: ["1 cup red lentils", "1 onion, diced"],
  steps: ["Simmer for 30 minutes."],
  servings: 4,
  minutes: 30,
  course: "main",
};

/** The test's households read every Doc as `reading`; test/setup.ts puts the next test back on a fake. */
function withReading(reading: RecipeReading): FakeLlm {
  const llm = new FakeLlm();
  llm.reading = reading;
  useLlm(() => llm);
  return llm;
}

async function newHousehold(): Promise<HouseholdStub> {
  const household = env.Household.getByName(crypto.randomUUID());
  await household.callTool("setup_household", { name: "The Example Family", weekStartsOn: "monday" });
  return household;
}

function succeeded<T>(result: ToolResult<unknown>): T {
  if (!result.ok) throw new Error(`Expected the tool call to succeed: ${result.error.message}`);
  return result.value as T;
}

async function importRuns(household: HouseholdStub): Promise<ImportRun[]> {
  return succeeded<ImportRun[]>(await household.callTool("list_import_runs", {}));
}

/** Starts a sync, as "Sync Drive now" does, and waits for its run to be logged. */
async function sync(household: HouseholdStub): Promise<ImportRun> {
  const before = (await importRuns(household)).length;
  expect(succeeded(await household.callTool("sync_drive_folder", {}))).toEqual({ alreadyRunning: false });
  return vi.waitFor(async () => {
    const runs = await importRuns(household);
    if (runs.length === before) throw new Error("The sync has not finished");
    return runs[0] as ImportRun;
  });
}

/** A fake model that reads nothing until `release` is called, as a slow one keeps a sync running. */
function withSlowReading(reading: RecipeReading): { release: () => void } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const llm = new FakeLlm();
  llm.reading = reading;
  const readRecipe = llm.readRecipe.bind(llm);
  llm.readRecipe = async (request) => {
    await gate;
    return readRecipe(request);
  };
  useLlm(() => llm);
  return { release };
}

async function drafts(household: HouseholdStub): Promise<Recipe[]> {
  return succeeded<Draft[]>(await household.callTool("list_drafts", {})).map((draft) => draft.recipe);
}

beforeEach(async () => {
  const listed = await env.BUCKET.list({ prefix: "photos/" });
  if (listed.objects.length > 0) await env.BUCKET.delete(listed.objects.map((object) => object.key));
});

describe("syncing the Drive folder", () => {
  test("has the model read a Doc dropped in the folder into a Draft, linking to the Doc", async () => {
    const exported = pretendGoogle([soupDoc()]);
    const llm = withReading(soup);
    const household = await newHousehold();

    const run = await sync(household);

    expect(run).toMatchObject({ source: "gdrive", created: 1, updated: 0, skipped: 0, flagged: 0, errors: [] });
    expect(llm.readings).toEqual([{ text: SOUP_MARKDOWN }]);
    expect(exported).toEqual(["1SoupDocId:text/markdown"]);
    const [draft] = await drafts(household);
    expect(draft).toMatchObject({
      title: "Grandma's Lentil Soup",
      draft: true,
      photoKey: null,
      source: { kind: "gdrive", url: "https://docs.google.com/document/d/1SoupDocId/edit" },
      ingredients: [{ raw: "1 cup red lentils" }, { raw: "1 onion, diced" }],
    });
  });

  test("answers at once, before the model has read a Doc, and logs the run once it has", async () => {
    pretendGoogle([soupDoc()]);
    const model = withSlowReading(soup);
    const household = await newHousehold();

    expect(succeeded(await household.callTool("sync_drive_folder", {}))).toEqual({ alreadyRunning: false });
    expect(await importRuns(household)).toEqual([]);

    model.release();
    await vi.waitFor(async () => expect(await importRuns(household)).toMatchObject([{ source: "gdrive", created: 1 }]));
  });

  test("answers that a sync is already running when asked again before it finishes, and runs it once", async () => {
    pretendGoogle([soupDoc()]);
    const model = withSlowReading(soup);
    const household = await newHousehold();
    succeeded(await household.callTool("sync_drive_folder", {}));

    expect(succeeded(await household.callTool("sync_drive_folder", {}))).toEqual({ alreadyRunning: true });

    model.release();
    await vi.waitFor(async () => expect(await importRuns(household)).toHaveLength(1));
    expect(await drafts(household)).toHaveLength(1);
  });

  test("skips a Doc unchanged since it was read, without exporting it, and updates its Draft once edited", async () => {
    const files = [soupDoc()];
    const exported = pretendGoogle(files);
    const llm = withReading(soup);
    const household = await newHousehold();
    await sync(household);

    expect(await sync(household)).toMatchObject({ created: 0, updated: 0, skipped: 1, flagged: 0, errors: [] });
    expect(exported).toHaveLength(1);

    files[0] = soupDoc({
      modifiedTime: "2026-10-22T19:40:00.000Z",
      markdown: `${SOUP_MARKDOWN}\n\nServe with lemon.`,
    });
    llm.reading = { ...soup, steps: ["Simmer for 30 minutes.", "Serve with lemon."] };

    expect(await sync(household)).toMatchObject({ created: 0, updated: 1, skipped: 0, flagged: 0 });
    const [draft] = await drafts(household);
    expect(draft?.steps).toEqual(["Simmer for 30 minutes.", "Serve with lemon."]);
    expect(await drafts(household)).toHaveLength(1);
  });

  test("flags an edited Doc for a merge when its Recipe was edited or accepted in Mise, once", async () => {
    const files = [soupDoc(), soupDoc({ id: "1StewDocId", name: "Stew", markdown: "# Stew\n\n* 1 kg beef" })];
    pretendGoogle(files);
    const llm = withReading(soup);
    const household = await newHousehold();
    await sync(household);
    const [stew, soupDraft] = (await drafts(household)) as [Recipe, Recipe];
    succeeded(await household.callTool("update_recipe", { id: soupDraft.id, title: "Our Lentil Soup" }));
    succeeded(await household.callTool("accept_draft", { id: stew.id }));

    const edited = { modifiedTime: "2026-10-23T07:00:00.000Z" };
    files[0] = soupDoc(edited);
    files[1] = { ...(files[1] as PretendFile), ...edited };
    llm.reading = { ...soup, title: "Lentil Soup, Revised" };

    expect(await sync(household)).toMatchObject({ created: 0, updated: 0, skipped: 0, flagged: 2 });
    const flags = succeeded<ImportFlag[]>(await household.callTool("list_import_flags", {}));
    expect(flags.map((flag) => [flag.kind, flag.recipe.title]).sort()).toEqual([
      ["merge", "Grandma's Lentil Soup"],
      ["merge", "Our Lentil Soup"],
    ]);
    expect(succeeded<Recipe>(await household.callTool("get_recipe", { id: soupDraft.id })).title).toBe(
      "Our Lentil Soup",
    );

    expect(await sync(household)).toMatchObject({ updated: 0, skipped: 2, flagged: 0 });
  });

  test("leaves a Recipe in Mise when its Doc is removed from the folder", async () => {
    const files = [soupDoc()];
    pretendGoogle(files);
    withReading(soup);
    const household = await newHousehold();
    await sync(household);

    files.pop();

    expect(await sync(household)).toMatchObject({ created: 0, updated: 0, skipped: 0, errors: [] });
    expect(await drafts(household)).toHaveLength(1);
  });

  test("lists a Doc that holds no recipe with its link, and skips it until it changes", async () => {
    const files = [soupDoc({ id: "1NotesDocId", name: "Shopping notes", markdown: "Remember the party on Friday." })];
    pretendGoogle(files);
    const llm = withReading({ isRecipe: false });
    const household = await newHousehold();

    expect(await sync(household)).toMatchObject({
      created: 0,
      skipped: 1,
      errors: [
        { entry: "https://docs.google.com/document/d/1NotesDocId/edit", message: "Shopping notes holds no recipe" },
      ],
    });
    expect(await sync(household)).toMatchObject({ created: 0, skipped: 1, errors: [] });
    expect(llm.readings).toHaveLength(1);

    files[0] = soupDoc({ id: "1NotesDocId", name: "Lentil soup", modifiedTime: "2026-10-23T07:00:00.000Z" });
    llm.reading = soup;

    expect(await sync(household)).toMatchObject({ created: 1, skipped: 0, errors: [] });
  });

  test("does not bring back a discarded Draft until its Doc changes", async () => {
    const files = [soupDoc()];
    pretendGoogle(files);
    withReading(soup);
    const household = await newHousehold();
    await sync(household);
    const [draft] = (await drafts(household)) as [Recipe];
    succeeded(await household.callTool("delete_recipe", { id: draft.id, confirm: true }));

    expect(await sync(household)).toMatchObject({ created: 0, skipped: 1 });
    expect(await drafts(household)).toEqual([]);
  });

  test("reads a Doc the model failed on again at the next sync", async () => {
    pretendGoogle([soupDoc()]);
    const llm = withReading(soup);
    llm.failing = true;
    const household = await newHousehold();

    expect(await sync(household)).toMatchObject({
      created: 0,
      errors: [
        {
          entry: "https://docs.google.com/document/d/1SoupDocId/edit",
          message: "Lentil soup: The model could not read the recipe: the fake is failing",
        },
      ],
    });
    llm.failing = false;

    expect(await sync(household)).toMatchObject({ created: 1, errors: [] });
  });

  test("tags a Doc with the subfolders it is filed in, mapped as Paprika's categories are", async () => {
    pretendGoogle([
      {
        id: "1FolderIndian",
        name: "Indian",
        mimeType: FOLDER_MIME,
        parent: FOLDER,
        modifiedTime: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "1FolderDinner",
        name: "Weeknight",
        mimeType: FOLDER_MIME,
        parent: "1FolderIndian",
        modifiedTime: "2026-10-01T00:00:00.000Z",
      },
      soupDoc({ parent: "1FolderDinner" }),
      {
        id: "1Sheet",
        name: "Budget",
        mimeType: "application/vnd.google-apps.spreadsheet",
        parent: FOLDER,
        modifiedTime: "2026-10-01T00:00:00.000Z",
      },
    ]);
    withReading({ ...soup, course: "side" });
    const household = await newHousehold();

    expect(await sync(household)).toMatchObject({ created: 1, errors: [] });
    const [draft] = await drafts(household);
    expect(draft).toMatchObject({ tags: ["indian", "weeknight"], cuisine: "indian", course: "main" });
  });

  test("makes the first image in a Doc its Draft's photo", async () => {
    const exported = pretendGoogle([
      soupDoc({
        markdown: `${SOUP_MARKDOWN}\n\n![][image1]\n\n[image1]: <data:image/jpeg;base64,/9j/4AAQ>`,
        zippedHtml: await zip([
          { name: "LentilSoup.html", data: utf8('<html><body><img src="images/image1.jpg"></body></html>') },
          { name: "images/image1.jpg", data: SAMPLE_JPEG },
        ]),
      }),
    ]);
    const llm = withReading(soup);
    const household = await newHousehold();

    expect(await sync(household)).toMatchObject({ created: 1, errors: [] });
    expect(llm.readings).toEqual([{ text: SOUP_MARKDOWN }]);
    expect(exported).toEqual(["1SoupDocId:text/markdown", "1SoupDocId:application/zip"]);
    const [draft] = await drafts(household);
    const photo = (await env.BUCKET.get(draft?.photoKey as string)) as R2ObjectBody;
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(SAMPLE_JPEG);
  });

  test("logs a folder not shared with the service account as the run's error", async () => {
    pretendGoogle([soupDoc()], false);
    const household = await newHousehold();

    expect(await sync(household)).toMatchObject({
      source: "gdrive",
      created: 0,
      errors: [{ entry: null, message: `The Drive folder was not found: share the folder with ${SERVICE_ACCOUNT}` }],
    });
  });

  test("is refused when the deployment has no Drive folder", async () => {
    const household = await newHousehold();

    const result = await household.callTool("sync_drive_folder", {});

    expect(result).toMatchObject({ ok: false, error: { code: "not_configured" } });
    expect(succeeded<ImportRun[]>(await household.callTool("list_import_runs", {}))).toEqual([]);
  });

  test("is run every night, and the next night's is scheduled", async () => {
    pretendGoogle([soupDoc()]);
    withReading(soup);
    const household = await newHousehold();

    await household.nightlyDriveSync();

    expect(succeeded<ImportRun[]>(await household.callTool("list_import_runs", {}))).toMatchObject([
      { source: "gdrive", created: 1 },
    ]);
    // Listed soonest first, so their order depends on the time of day.
    const schedules = (await household.listSchedules()) as { callback: string }[];
    const callbacks = schedules.map((schedule) => schedule.callback);
    expect(callbacks.sort()).toEqual(["morningPushes", "nightlyDriveSync", "nightlyExport"]);
  });

  test("keeps what it read in the export, so a restored Household skips the same Docs", async () => {
    pretendGoogle([soupDoc({ id: "1NotesDocId", name: "Notes", markdown: "Party on Friday." })]);
    withReading({ isRecipe: false });
    const original = await newHousehold();
    await sync(original);
    const exported = await (await original.fetch(`${HOUSEHOLD_URL}/export`)).text();
    expect(JSON.parse(exported).tables.drive_doc).toEqual([
      { doc_id: "1NotesDocId", modified_time: "2026-10-20T08:15:00.000Z" },
    ]);

    const restored = env.Household.getByName(crypto.randomUUID());
    const response = await restored.fetch(`${HOUSEHOLD_URL}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: exported,
    });
    expect(response.status).toBe(200);

    expect(await sync(restored)).toMatchObject({ created: 0, skipped: 1, errors: [] });
  });

  test("a restore refuses a revision record that is not one", async () => {
    pretendGoogle([soupDoc({ id: "1NotesDocId", name: "Notes", markdown: "Party on Friday." })]);
    withReading({ isRecipe: false });
    const original = await newHousehold();
    await sync(original);
    const exported = JSON.parse(await (await original.fetch(`${HOUSEHOLD_URL}/export`)).text());
    exported.tables.drive_doc[0].modified_time = "last Tuesday";

    const response = await env.Household.getByName(crypto.randomUUID()).fetch(`${HOUSEHOLD_URL}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exported),
    });

    expect(response.status).toBe(400);
  });
});

describe("a Drive sync's notifications", () => {
  /** A device that gets every Drive and review notification, through a pretend push service. */
  async function subscribedDevice(household: HouseholdStub) {
    const key = await vapidKey();
    const service = pretendPushService(key.publicKey, "https://mise.example.com");
    usePush(() => webPush({ privateKey: key.secret, subject: "https://mise.example.com" }, service.fetch));
    const device = await newDevice("https://push.example.com/send/kitchen-tablet");
    service.add(device);
    await household.callTool("subscribe_push", {
      ...subscriptionOf(device),
      kinds: ["review_waiting", "drive_flagged"],
    });
    return () => service.received(device.endpoint);
  }

  test("tells the devices what waits for review once Docs became Drafts", async () => {
    pretendGoogle([soupDoc()]);
    withReading(soup);
    const household = await newHousehold();
    const received = await subscribedDevice(household);

    await sync(household);

    await vi.waitFor(() =>
      expect(received()).toEqual([
        { kind: "review_waiting", title: "Waiting for review", body: "1 Draft Recipe.", url: "/?review" },
      ]),
    );
  });

  test("tells the devices when it flagged Recipes edited in Mise, and says nothing when nothing changed", async () => {
    const files = [soupDoc()];
    pretendGoogle(files);
    const llm = withReading(soup);
    const household = await newHousehold();
    await sync(household);
    const [draft] = (await drafts(household)) as [Recipe];
    succeeded(await household.callTool("accept_draft", { id: draft.id }));
    const received = await subscribedDevice(household);

    await sync(household);
    files[0] = soupDoc({ modifiedTime: "2026-10-23T07:00:00.000Z" });
    llm.reading = { ...soup, title: "Lentil Soup, Revised" };
    await sync(household);

    await vi.waitFor(() =>
      expect(received()).toEqual([
        {
          kind: "drive_flagged",
          title: "Drive sync flagged 1 Recipe",
          body: "Changed in Drive after being edited in Mise, or like a Recipe already kept. Look them over.",
          url: "/?review",
        },
      ]),
    );
  });
});
