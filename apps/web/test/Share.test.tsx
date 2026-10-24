import type { ImportRun, ToolOutput } from "@mise/domain";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { expect, onTestFinished, test } from "vitest";
import { SharePage } from "../src/Share";
import { createFakeClient } from "./fakeClient";

const DAL_LINK = "https://recipes.example/red-lentil-dal";

const run: ImportRun = {
  id: 3,
  source: "url",
  startedAt: "2026-10-22T19:00:00.000Z",
  created: 1,
  updated: 0,
  skipped: 0,
  flagged: 0,
  errors: [],
};

function fakeClient(output: ToolOutput<"import_url">, options: { online?: boolean; signedIn?: boolean } = {}) {
  const calls: { name: string; input: unknown }[] = [];
  const fake = createFakeClient(
    (name, input) => {
      calls.push({ name, input });
      if (name === "import_url") return { ok: true, value: output };
      throw new Error(`Unexpected tool ${name}`);
    },
    { online: options.online, signedIn: async () => options.signedIn ?? true },
  );
  return { ...fake, calls };
}

test("a shared link is imported, and the Recipe it made is a link away", async () => {
  const { client, calls } = fakeClient({
    run,
    recipe: { id: 4, title: "Red Lentil Dal", draft: false, linkOnly: false },
  });
  render(() => <SharePage client={client} url={DAL_LINK} />);

  expect((await screen.findByRole("status")).textContent).toBe("Red Lentil Dal is in your Recipes.");
  expect(calls).toEqual([{ name: "import_url", input: { url: DAL_LINK } }]);
  expect(screen.getByRole("link", { name: "Open Red Lentil Dal" }).getAttribute("href")).toBe("/?recipe=4");
});

test("a shared link the model read, or could not read, is a Draft a link away on the Review screen", async () => {
  const { client } = fakeClient({ run, recipe: { id: 12, title: "Shepherd's Pie", draft: true, linkOnly: false } });
  render(() => <SharePage client={client} url={DAL_LINK} />);

  expect((await screen.findByRole("status")).textContent).toBe(
    "Shepherd's Pie is waiting on the Review screen as a Draft, until someone checks it.",
  );
  expect(screen.getByRole("link", { name: "Review Shepherd's Pie" }).getAttribute("href")).toBe("/?review");
  cleanup();

  const linkOnly = fakeClient({ run, recipe: { id: 13, title: "Dal Video", draft: true, linkOnly: true } });
  render(() => <SharePage client={linkOnly.client} url={DAL_LINK} />);

  expect((await screen.findByRole("status")).textContent).toBe(
    "Mise could not read a recipe at that link, so it kept the link as a Draft: Dal Video. Add screenshots or paste the recipe's text to fill it in.",
  );
  expect(screen.getByRole("link", { name: "Review Dal Video" }).getAttribute("href")).toBe("/?review");
});

test("when Safari isn't signed in to Mise yet, the page says to sign in once, and links back here to do it", async () => {
  window.history.replaceState(null, "", `/share?url=${encodeURIComponent(DAL_LINK)}`);
  onTestFinished(() => window.history.replaceState(null, "", "/"));
  const { client } = fakeClient(
    { run, recipe: { id: 4, title: "Red Lentil Dal", draft: false, linkOnly: false } },
    { online: false, signedIn: false },
  );
  render(() => <SharePage client={client} url={DAL_LINK} />);

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Safari isn't signed in to Mise yet. Sign in once, and every link you share after that goes straight in.",
  );
  expect(screen.getByRole("link", { name: "Sign in and import the link" }).getAttribute("href")).toBe(
    window.location.href,
  );
});

test("when Mise can't be reached, the page says so rather than waiting", async () => {
  const { client } = fakeClient(
    { run, recipe: { id: 4, title: "Red Lentil Dal", draft: false, linkOnly: false } },
    { online: false, signedIn: true },
  );
  render(() => <SharePage client={client} url={DAL_LINK} />);

  expect((await screen.findByRole("alert")).textContent).toBe(
    "Mise can't be reached right now. Share the link again once you have a connection.",
  );
  expect(screen.queryByRole("link", { name: "Sign in and import the link" })).toBeNull();
});

test("a page opened without a link says to share one", async () => {
  const { client, calls } = fakeClient({
    run,
    recipe: { id: 4, title: "Red Lentil Dal", draft: false, linkOnly: false },
  });
  render(() => <SharePage client={client} url={null} />);

  expect((await screen.findByRole("alert")).textContent).toBe(
    "There is no link to import. Share a recipe page or a video to Mise from the share sheet.",
  );
  expect(calls).toEqual([]);
});

test("a connection that drops and comes back while importing leaves only what the link became", async () => {
  let answer: (output: unknown) => void = () => {};
  const fake = createFakeClient((name) => {
    if (name !== "import_url") throw new Error(`Unexpected tool ${name}`);
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  render(() => <SharePage client={fake.client} url={DAL_LINK} />);
  await screen.findByText("Importing…");

  fake.goOffline();
  expect((await screen.findByRole("alert")).textContent).toBe(
    "Mise can't be reached right now. Share the link again once you have a connection.",
  );
  fake.goOnline();
  answer({ ok: true, value: { run, recipe: { id: 4, title: "Red Lentil Dal", draft: false, linkOnly: false } } });

  expect((await screen.findByRole("status")).textContent).toBe("Red Lentil Dal is in your Recipes.");
  expect(screen.queryByRole("alert")).toBeNull();
});
