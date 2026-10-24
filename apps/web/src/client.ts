import {
  ChangeNotice,
  type ChangeTopic,
  type ChatMessage,
  type ChatReply,
  type ChatWhere,
  HOUSEHOLD_AGENT,
  HOUSEHOLD_PATH,
  PAPRIKA_UPLOAD_PATH,
  type RecipeId,
  recipePhotoPath,
  SCREENSHOT_UPLOAD_PATH,
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
  /**
   * Sends a message to the agent, from the screen and Week `where` names, and resolves with its
   * answer, which can take a while.
   */
  chat(text: string, where: ChatWhere): Promise<ChatReply>;
  /** The latest turns of the Household's conversation with the agent, oldest first. */
  conversation(): Promise<ChatMessage[]>;
  /** Where to load a Recipe's photo from; the key makes a new photo a new URL. */
  photoUrl(recipeId: RecipeId, photoKey: string): string;
  /** Photos are too big for a tool call, so they go over HTTP. True once stored. */
  uploadPhoto(recipeId: RecipeId, photo: Blob): Promise<boolean>;
  removePhoto(recipeId: RecipeId): Promise<boolean>;
  /** Uploads a Paprika export over HTTP too (ADR 0011); `run_paprika_import` takes the id returned. Null if refused. */
  uploadExport(file: Blob): Promise<string | null>;
  /** Uploads one screenshot the same way; `import_screenshots` takes the ids returned. Null if refused. */
  uploadScreenshot(file: Blob): Promise<string | null>;
  /**
   * Whether this browser is signed in to Access, asked when the household can't be reached: Safari
   * keeps its own sign-in, apart from the app on the home screen. A route that can't be reached at all
   * is no sign-in problem, so that counts as signed in.
   */
  signedIn(): Promise<boolean>;
  close(): void;
};

/** How long an answer from the agent may take: a model turn or several, each with its tool calls. */
const CHAT_TIMEOUT_MS = 120_000;

/** The tools that read a recipe with the model, or a whole export: slower than a call's usual 30 seconds. */
const SLOW_TOOLS: ReadonlySet<ToolName> = new Set(["import_url", "import_text", "run_paprika_import"]);
const SLOW_TOOL_TIMEOUT_MS = 120_000;

export function createMiseClient(host = window.location.host): MiseClient {
  const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host });

  return {
    call: (name, input) =>
      agent.call("callTool", [name, input], SLOW_TOOLS.has(name) ? { timeout: SLOW_TOOL_TIMEOUT_MS } : undefined),

    subscribe: (topics, refetch) => subscribeTo(agent, topics, refetch),

    chat: (text, where) => agent.call("chat", [text, where], { timeout: CHAT_TIMEOUT_MS }),

    conversation: () => agent.call("conversation", []),

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
      return upload(PAPRIKA_UPLOAD_PATH, file, "application/octet-stream");
    },

    async uploadScreenshot(file) {
      return upload(SCREENSHOT_UPLOAD_PATH, file, file.type);
    },

    async signedIn() {
      try {
        // Access sends a request without a session to sign in; the Worker refuses one without an identity.
        const response = await fetch(HOUSEHOLD_PATH, { redirect: "manual" });
        const status = response.status;
        return !(response.type === "opaqueredirect" || (status >= 300 && status < 400) || status === 401);
      } catch {
        return true;
      }
    },

    close: () => agent.close(),
  };
}

/** PUTs a file to stage it for an import; the id the household gave it, or null if refused. */
async function upload(path: string, file: Blob, type: string): Promise<string | null> {
  const response = await fetch(path, { method: "PUT", headers: { "Content-Type": type }, body: file });
  if (!response.ok) return null;
  const { upload } = (await response.json()) as { upload?: unknown };
  return typeof upload === "string" ? upload : null;
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
