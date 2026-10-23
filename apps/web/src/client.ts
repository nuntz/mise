import {
  ChangeNotice,
  type ChangeTopic,
  HOUSEHOLD_AGENT,
  PAPRIKA_UPLOAD_PATH,
  type RecipeId,
  recipePhotoPath,
  type ToolInput,
  type ToolName,
  type ToolOutput,
  type ToolResult,
} from "@mise/domain";
import { AgentClient } from "agents/client";

export type MiseClient = {
  /** Calls a tool through the household's single entry point. */
  call<N extends ToolName>(name: N, input: ToolInput<N>): Promise<ToolResult<ToolOutput<N>>>;
  /**
   * Runs `refetch` straight away if connected (else once the connection opens), whenever any of
   * `topics` changes, and once on every reconnect so nothing missed while offline goes stale. Use
   * `keepFresh` rather than calling this directly. Returns an unsubscribe function.
   */
  subscribe(topics: readonly ChangeTopic[], refetch: () => void): () => void;
  /**
   * Calls `listener` with whether the household is reachable: now, and whenever that changes. Until
   * the first attempt to connect fails, it counts as reachable. Returns an unsubscribe function.
   */
  onConnection(listener: (online: boolean) => void): () => void;
  /** Where to load a Recipe's photo from; the key makes a new photo a new URL. */
  photoUrl(recipeId: RecipeId, photoKey: string): string;
  /** Photos are too big for a tool call, so they go over HTTP. True once stored. */
  uploadPhoto(recipeId: RecipeId, photo: Blob): Promise<boolean>;
  removePhoto(recipeId: RecipeId): Promise<boolean>;
  /** Uploads a Paprika export over HTTP too (ADR 0011); `run_paprika_import` takes the id returned. Null if refused. */
  uploadExport(file: Blob): Promise<string | null>;
  close(): void;
};

export function createMiseClient(host = window.location.host): MiseClient {
  const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host });

  return {
    call: (name, input) => agent.call("callTool", [name, input]),

    subscribe: (topics, refetch) => subscribeTo(agent, topics, refetch),

    onConnection(listener) {
      // Connecting counts as reachable, so a page loaded with a signal doesn't flash "offline".
      listener(agent.readyState !== WebSocket.CLOSED);
      const open = () => listener(true);
      const close = () => listener(false);
      agent.addEventListener("open", open);
      agent.addEventListener("close", close);
      // A socket can stay open for minutes after the signal goes; the browser often knows sooner.
      window.addEventListener("offline", close);
      return () => {
        agent.removeEventListener("open", open);
        agent.removeEventListener("close", close);
        window.removeEventListener("offline", close);
      };
    },

    photoUrl: (recipeId, photoKey) => `${recipePhotoPath(recipeId)}?v=${encodeURIComponent(photoKey)}`,

    async uploadPhoto(recipeId, photo) {
      const response = await fetch(recipePhotoPath(recipeId), {
        method: "PUT",
        headers: { "Content-Type": photo.type },
        body: photo,
      });
      return response.ok;
    },

    async removePhoto(recipeId) {
      return (await fetch(recipePhotoPath(recipeId), { method: "DELETE" })).ok;
    },

    async uploadExport(file) {
      const response = await fetch(PAPRIKA_UPLOAD_PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      if (!response.ok) return null;
      const { upload } = (await response.json()) as { upload?: unknown };
      return typeof upload === "string" ? upload : null;
    },

    close: () => agent.close(),
  };
}

/** Where change notices arrive: the household's socket. */
export type ChangeSource = Pick<EventTarget, "addEventListener" | "removeEventListener"> & { readyState: number };

/** `MiseClient.subscribe`, over `socket`. */
export function subscribeTo(socket: ChangeSource, topics: readonly ChangeTopic[], refetch: () => void): () => void {
  const onMessage = (event: Event) => {
    const { data } = event as MessageEvent;
    if (typeof data !== "string") return;
    const notice = ChangeNotice.safeParse(safeJson(data));
    if (notice.success && topics.includes(notice.data.topic)) refetch();
  };
  const onOpen = () => refetch();
  socket.addEventListener("message", onMessage);
  socket.addEventListener("open", onOpen);
  // Opened before this subscribed, so the open above won't come: fetch now. Connecting, it will.
  if (socket.readyState === WebSocket.OPEN) refetch();
  return () => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("open", onOpen);
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
