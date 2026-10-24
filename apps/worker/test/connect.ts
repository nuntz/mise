import type { env } from "cloudflare:workers";
import type { ChangeNotice } from "@mise/domain";
import { CALLER_HEADER } from "../src/identity";

type HouseholdStub = ReturnType<typeof env.Household.getByName>;

/**
 * Opens a WebSocket to the household as `email`, stamped as the Worker stamps it after Access
 * (identity.test.ts covers that step), and calls the household over the Agents SDK's RPC protocol.
 * Keeps the change notices it is sent.
 */
export async function connectAs(household: HouseholdStub, email: string) {
  const response = await household.fetch("http://mise.example.com/agents/household/household", {
    headers: { Upgrade: "websocket", [CALLER_HEADER]: JSON.stringify({ email }) },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error(`Expected a WebSocket upgrade, got ${response.status}`);
  socket.accept();

  const replies = new Map<string, (reply: { success: boolean; result?: unknown; error?: string }) => void>();
  const notices: ChangeNotice[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "rpc") replies.get(message.id)?.(message);
    if (message.type === "mise:change") notices.push(message);
  });

  const rpc = (method: string, args: unknown[]) =>
    new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID();
      replies.set(id, (reply) => (reply.success ? resolve(reply.result) : reject(new Error(reply.error))));
      socket.send(JSON.stringify({ type: "rpc", id, method, args }));
    });

  return {
    call: (name: string, input: unknown) => rpc("callTool", [name, input]),
    rpc,
    notices,
  };
}
