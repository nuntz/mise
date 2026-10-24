import { type ChangeTopic, HOUSEHOLD_PATH } from "@mise/domain";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { type ChangeSource, createMiseClient, subscribeTo } from "../src/client";
import { createFakeClient } from "./fakeClient";

/** A way to subscribe, and to drive the connection under it. */
type Harness = {
  subscribe(topics: readonly ChangeTopic[], refetch: () => void): () => void;
  notify(topic: ChangeTopic): void;
  goOffline(): void;
  goOnline(): void;
};

/** The real client's subscribe, over a socket the test opens, closes and sends notices on. */
function realClient({ online }: { online: boolean }): Harness {
  const socket = Object.assign(new EventTarget(), {
    readyState: online ? WebSocket.OPEN : (WebSocket.CONNECTING as number),
  });
  return {
    subscribe: (topics, refetch) => subscribeTo(socket as ChangeSource, topics, refetch),
    notify(topic) {
      const notice = { type: "mise:change", topic, revision: 1 };
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(notice) }));
    },
    goOffline() {
      socket.readyState = WebSocket.CLOSED;
      socket.dispatchEvent(new Event("close"));
    },
    goOnline() {
      socket.readyState = WebSocket.OPEN;
      socket.dispatchEvent(new Event("open"));
    },
  };
}

function fakeClient({ online }: { online: boolean }): Harness {
  const fake = createFakeClient(() => undefined, { online });
  return { ...fake, subscribe: fake.client.subscribe };
}

describe.each([
  ["the real client", realClient],
  ["the test fake", fakeClient],
])("subscribing, with %s", (_name, connect) => {
  test("fetches once straight away while connected, however many topics", () => {
    const refetch = vi.fn();
    connect({ online: true }).subscribe(["plan", "recipes", "household"], refetch);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test("fetches again on a change to any of its topics, and only those", () => {
    const harness = connect({ online: true });
    const refetch = vi.fn();
    harness.subscribe(["plan", "recipes"], refetch);
    harness.notify("recipes");
    harness.notify("grocery");
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  test("while not connected, waits for the connection, then fetches once on every reconnect", () => {
    const harness = connect({ online: false });
    const refetch = vi.fn();
    harness.subscribe(["plan", "recipes"], refetch);
    expect(refetch).not.toHaveBeenCalled();
    harness.goOnline();
    expect(refetch).toHaveBeenCalledTimes(1);
    harness.goOffline();
    harness.goOnline();
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  test("stops once unsubscribed", () => {
    const harness = connect({ online: true });
    const refetch = vi.fn();
    const unsubscribe = harness.subscribe(["plan"], refetch);
    unsubscribe();
    harness.notify("plan");
    harness.goOffline();
    harness.goOnline();
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("whether Safari is signed in, with the real client", () => {
  const signedIn = (response: Response | Error) => {
    const fetch = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const client = createMiseClient("mise.example");
    onTestFinished(() => client.close());
    return { result: client.signedIn(), fetch };
  };

  test("is signed in when the household's route answers, even with a not found", async () => {
    const { result, fetch } = signedIn(new Response("Not found", { status: 404 }));
    expect(await result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(HOUSEHOLD_PATH, { redirect: "manual" });
  });

  test("is not signed in when Access sends the request to sign in, or the Worker refuses it", async () => {
    expect(await signedIn(Response.redirect("https://team.example/cdn-cgi/access/login", 302)).result).toBe(false);
    const redirected = Object.defineProperty(new Response(null), "type", { value: "opaqueredirect" });
    expect(await signedIn(redirected).result).toBe(false);
    expect(await signedIn(new Response("Sign in through Cloudflare Access", { status: 401 })).result).toBe(false);
  });

  test("counts as signed in when the route can't be reached at all, which is no sign-in problem", async () => {
    expect(await signedIn(new TypeError("Failed to fetch")).result).toBe(true);
  });
});
