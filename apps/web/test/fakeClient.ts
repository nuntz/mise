import type { ChangeTopic } from "@mise/domain";
import type { MiseClient } from "../src/client";

type Call = (name: string, input: Record<string, unknown>) => unknown;

/**
 * A client that answers tool calls with `call`, over a connection the test controls. Its `subscribe`
 * keeps the real client's contract (see `MiseClient.subscribe`), so a screen that leans on a fetch the
 * real client wouldn't make fails here too. Offline, every call fails, as the real one does.
 */
export function createFakeClient(
  call: Call,
  {
    online = true,
    chat,
    conversation,
    ...rest
  }: { online?: boolean } & Partial<
    Pick<MiseClient, "photoUrl" | "uploadExport" | "chat" | "conversation" | "signedIn">
  > = {},
) {
  const connection = { online };
  const subscriptions = new Set<{ topics: readonly ChangeTopic[]; refetch: () => void }>();
  const listeners = new Set<(online: boolean) => void>();
  const setOnline = (value: boolean) => {
    const reconnected = value && !connection.online;
    connection.online = value;
    for (const listener of listeners) listener(value);
    if (reconnected) for (const subscription of [...subscriptions]) subscription.refetch();
  };
  const client: MiseClient = {
    call: (async (name: string, input: Record<string, unknown>) => {
      if (!connection.online) throw new Error("Connection closed");
      return call(name, input);
    }) as MiseClient["call"],
    async chat(text) {
      if (!connection.online) throw new Error("Connection closed");
      if (!chat) throw new Error("Unexpected chat");
      return chat(text);
    },
    async conversation() {
      if (!connection.online) throw new Error("Connection closed");
      if (!conversation) throw new Error("Unexpected conversation");
      return conversation();
    },
    subscribe(topics, refetch) {
      const subscription = { topics, refetch };
      subscriptions.add(subscription);
      if (connection.online) refetch();
      return () => subscriptions.delete(subscription);
    },
    onConnection(listener) {
      listener(connection.online);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    photoUrl: (id, key) => `/photos/${id}?v=${key}`,
    uploadPhoto: async () => true,
    removePhoto: async () => true,
    uploadExport: async () => null,
    signedIn: async () => true,
    close() {},
    ...rest,
  };
  return {
    client,
    /** A change notice for `topic`. */
    notify(topic: ChangeTopic) {
      if (!connection.online) return;
      for (const subscription of [...subscriptions]) if (subscription.topics.includes(topic)) subscription.refetch();
    },
    goOnline: () => setOnline(true),
    goOffline: () => setOnline(false),
  };
}
