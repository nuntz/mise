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
