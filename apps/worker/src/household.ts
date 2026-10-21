import { type ChangeNotice, changeTopicOf, parseToolInput, type ToolName, type ToolResult } from "@mise/domain";
import { Agent, callable } from "agents";
import { migrate } from "./migrations";
import { handlers } from "./tools";

/** The household Durable Object: the one place Mise's data lives. */
export class Household extends Agent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs before any request, RPC call or WebSocket message is served.
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  /** The single entry point to every tool (ADR 0002). Input is validated against the registry. */
  @callable()
  callTool(name: string, input: unknown): ToolResult<unknown> {
    const parsed = parseToolInput(name, input);
    if (!parsed.ok) return parsed;
    const toolName = name as ToolName;
    const handler = handlers[toolName] as (sql: SqlStorage, input: unknown) => ToolResult<unknown>;
    const topic = changeTopicOf(toolName);

    const { result, revision } = this.ctx.storage.transactionSync(() => {
      const result = handler(this.ctx.storage.sql, parsed.value);
      if (!result.ok || !topic) return { result, revision: undefined };
      return { result, revision: this.bumpRevision() };
    });

    if (topic && revision !== undefined) {
      this.broadcast(JSON.stringify({ type: "mise:change", topic, revision } satisfies ChangeNotice));
    }
    return result;
  }

  private bumpRevision(): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>("UPDATE revision SET value = value + 1 WHERE id = 1 RETURNING value")
      .one().value;
  }
}
