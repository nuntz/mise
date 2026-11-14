import type { ChangeNotice, ChangeTopic, RecipeId } from "@mise/domain";
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
    confirm,
    startVoice,
    moveVoice,
    endVoice,
    voiceAvailability,
    ...rest
  }: { online?: boolean } & Partial<
    Pick<
      MiseClient,
      | "photoUrl"
      | "uploadPhoto"
      | "uploadExport"
      | "uploadScreenshot"
      | "chat"
      | "conversation"
      | "confirm"
      | "startVoice"
      | "moveVoice"
      | "endVoice"
      | "voiceAvailability"
      | "signedIn"
    >
  > = {},
) {
  const connection = { online };
  const subscriptions = new Set<{ topics: readonly ChangeTopic[]; refetch: (notice?: ChangeNotice) => void }>();
  let revision = 0;
  const listeners = new Set<(online: boolean) => void>();
  const stepListeners = new Set<(step: number) => void>();
  const setOnline = (value: boolean) => {
    const reconnected = value && !connection.online;
    connection.online = value;
    for (const listener of listeners) listener(value);
    if (reconnected) for (const subscription of [...subscriptions]) subscription.refetch();
  };
  const notifyAll = (topic: ChangeTopic, recipes?: RecipeId[]) => {
    if (!connection.online) return;
    revision += 1;
    const notice: ChangeNotice = { type: "mise:change", topic, revision, ...(recipes && { recipes }) };
    for (const subscription of [...subscriptions])
      if (subscription.topics.includes(topic)) subscription.refetch(notice);
  };
  const client: MiseClient = {
    call: (async (name: string, input: Record<string, unknown>) => {
      if (!connection.online) throw new Error("Connection closed");
      return call(name, input);
    }) as MiseClient["call"],
    async chat(text, where) {
      if (!connection.online) throw new Error("Connection closed");
      if (!chat) throw new Error("Unexpected chat");
      const reply = await chat(text, where);
      // The household announces the conversation once a turn is answered, or fails to be.
      notifyAll("chat");
      return reply;
    },
    async conversation() {
      if (!connection.online) throw new Error("Connection closed");
      if (!conversation) throw new Error("Unexpected conversation");
      return conversation();
    },
    async confirm(id) {
      if (!connection.online) throw new Error("Connection closed");
      if (!confirm) throw new Error("Unexpected confirm");
      const result = await confirm(id);
      // The household announces the conversation once a tap has run its call, or found it expired.
      if (result.ok || result.error.code === "expired") notifyAll("chat");
      return result;
    },
    async startVoice(offer, where) {
      if (!connection.online) throw new Error("Connection closed");
      if (!startVoice) throw new Error("Unexpected startVoice");
      return startVoice(offer, where);
    },
    async moveVoice(where) {
      if (!connection.online) throw new Error("Connection closed");
      if (!moveVoice) throw new Error("Unexpected moveVoice");
      return moveVoice(where);
    },
    async endVoice() {
      if (!connection.online) throw new Error("Connection closed");
      if (!endVoice) throw new Error("Unexpected endVoice");
      return endVoice();
    },
    async voiceAvailability() {
      if (!connection.online) throw new Error("Connection closed");
      if (!voiceAvailability) throw new Error("Unexpected voiceAvailability");
      return voiceAvailability();
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
    onShowStep(listener) {
      stepListeners.add(listener);
      return () => stepListeners.delete(listener);
    },
    photoUrl: (id, key) => `/photos/${id}?v=${key}`,
    uploadPhoto: async () => true,
    removePhoto: async () => true,
    uploadExport: async () => null,
    uploadScreenshot: async () => null,
    signedIn: async () => true,
    close() {},
    ...rest,
  };
  return {
    client,
    /** A change notice for `topic`, naming `recipes` if given. */
    notify: notifyAll,
    /** The household telling this device's Voice Session to show `step`; it arrives only while connected. */
    showStep(step: number) {
      if (!connection.online) return;
      for (const listener of [...stepListeners]) listener(step);
    },
    goOnline: () => setOnline(true),
    goOffline: () => setOnline(false),
  };
}
