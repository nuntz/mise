import { screen } from "@solidjs/testing-library";
import { expect, test, vi } from "vitest";
import { createMiseClient } from "../src/client";
import { createFakeClient } from "./fakeClient";

vi.mock("../src/client", () => ({ createMiseClient: vi.fn() }));

test("startup shares one client across the app's subscriptions and tool calls", async () => {
  const fake = createFakeClient((name) => {
    if (name === "get_household") return { ok: true, value: null };
    throw new Error(`Unexpected tool ${name}`);
  });
  vi.mocked(createMiseClient).mockReturnValue(fake.client);
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  try {
    await import("../src/main");
    expect(createMiseClient).toHaveBeenCalledTimes(1);
  } finally {
    root.remove();
  }
});

test("/share opens the share page on the shared link, not the app", async () => {
  vi.resetModules();
  const link = "https://recipes.example/red-lentil-dal";
  const calls: unknown[] = [];
  const fake = createFakeClient((name, input) => {
    calls.push({ name, input });
    if (name === "import_url") return { ok: false, error: { code: "not_found", message: "" } };
    throw new Error(`Unexpected tool ${name}`);
  });
  vi.mocked(createMiseClient).mockReturnValue(fake.client);
  window.history.replaceState(null, "", `/share?url=${encodeURIComponent(link)}`);
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  try {
    await import("../src/main");
    expect(await screen.findByRole("heading", { name: "Share to Mise" })).toBeTruthy();
    expect(calls).toEqual([{ name: "import_url", input: { url: link } }]);
  } finally {
    root.remove();
    window.history.replaceState(null, "", "/");
  }
});
