import {
  ChangeNotice,
  type ChangeTopic,
  HOUSEHOLD_AGENT,
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
   * Runs `refetch` whenever `topic` changes, and on every (re)connect so nothing missed
   * while offline goes stale. Returns an unsubscribe function.
   */
  subscribe(topic: ChangeTopic, refetch: () => void): () => void;
  /** Where to load a Recipe's photo from; the key makes a new photo a new URL. */
  photoUrl(recipeId: RecipeId, photoKey: string): string;
  /** Photos are too big for a tool call, so they go over HTTP. True once stored. */
  uploadPhoto(recipeId: RecipeId, photo: Blob): Promise<boolean>;
  removePhoto(recipeId: RecipeId): Promise<boolean>;
  close(): void;
};

export function createMiseClient(host = window.location.host): MiseClient {
  const agent = new AgentClient({ ...HOUSEHOLD_AGENT, host });

  return {
    call: (name, input) => agent.call("callTool", [name, input]),

    subscribe(topic, refetch) {
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        const notice = ChangeNotice.safeParse(safeJson(event.data));
        if (notice.success && notice.data.topic === topic) refetch();
      };
      agent.addEventListener("message", onMessage);
      agent.addEventListener("open", refetch);
      return () => {
        agent.removeEventListener("message", onMessage);
        agent.removeEventListener("open", refetch);
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

    close: () => agent.close(),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
