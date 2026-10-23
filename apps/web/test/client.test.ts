import type { ChangeTopic } from "@mise/domain";
import { describe, expect, test, vi } from "vitest";
import { type ChangeSource, subscribeTo } from "../src/client";
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
