import {
  type Caller,
  type ChangeNotice,
  ChangeTopic,
  changeTopicOf,
  exportKey,
  type Household as HouseholdData,
  isToolName,
  localDate,
  NIGHTLY_EXPORT_TIME,
  nextOccurrence,
  PHOTO_PREFIX,
  parseToolInput,
  type ToolContext,
  type ToolName,
  type ToolResult,
} from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from "agents";
import { exportHousehold, type RestoreError, restoreHousehold } from "./backup";
import { callerFrom } from "./identity";
import { migrate } from "./migrations";
import { sentryOptions } from "./observability";
import { handlers } from "./tools";

const RESTORE_STATUS: Record<RestoreError["code"], number> = {
  invalid_export: 400,
  schema_mismatch: 409,
  not_empty: 409,
};

/** What the household remembers about each WebSocket; it survives hibernation. */
type ConnectionState = { caller: Caller | null };

/** The household Durable Object: the one place Mise's data lives. */
class HouseholdAgent extends Agent<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs before any request, RPC call or WebSocket message is served.
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
  }

  override async onStart(): Promise<void> {
    await this.scheduleNightlyExport();
  }

  /** Remembers who opened the connection, as the Worker resolved them, for every tool call it makes. */
  override async onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext): Promise<void> {
    connection.setState({ caller: callerFrom(ctx.request) });
    await super.onConnect(connection, ctx);
  }

  /** The single entry point to every tool (ADR 0002). Input is validated against the registry. */
  @callable()
  async callTool(name: string, input: unknown): Promise<ToolResult<unknown>> {
    // One span per tool, named but without its input: inputs are Household data.
    const spanName = `tool ${isToolName(name) ? name : "unknown"}`;
    return Sentry.startSpan({ name: spanName, op: "mise.tool" }, () => this.runTool(name, input));
  }

  private async runTool(name: string, input: unknown): Promise<ToolResult<unknown>> {
    const parsed = parseToolInput(name, input);
    if (!parsed.ok) return parsed;
    const toolName = name as ToolName;
    const handler = handlers[toolName] as (
      sql: SqlStorage,
      input: unknown,
      context: ToolContext,
    ) => ToolResult<unknown>;
    const context: ToolContext = { caller: this.callerOf(getCurrentAgent().connection) };
    const topic = changeTopicOf(toolName);

    const { result, revision } = this.ctx.storage.transactionSync(() => {
      const result = handler(this.ctx.storage.sql, parsed.value, context);
      if (!result.ok || !topic) return { result, revision: undefined };
      return { result, revision: this.bumpRevision() };
    });

    if (topic && revision !== undefined) {
      this.notify(topic, revision);
      // The Household's timezone decides when the export runs.
      if (topic === "household") await this.scheduleNightlyExport();
    }
    return result;
  }

  /** Writes tonight's export to R2, then schedules tomorrow's. Run by the scheduler at 03:00 Household time. */
  async nightlyExport(): Promise<void> {
    try {
      const household = this.household();
      if (!household) return;
      await this.env.BUCKET.put(exportKey(localDate(new Date(), household.timezone)), await this.exportFile(), {
        httpMetadata: { contentType: "application/json" },
      });
    } catch (error) {
      // The scheduler swallows callback errors, so report them here.
      Sentry.captureException(error);
      throw error;
    } finally {
      // A failed night must not stop the next one.
      await this.scheduleNightlyExport();
    }
  }

  /** Backup over HTTP: `GET …/export` downloads the export, `POST …/restore` loads one into an empty household. */
  override async onRequest(request: Request): Promise<Response> {
    const action = new URL(request.url).pathname.split("/").at(-1);
    if (request.method === "GET" && action === "export") {
      return new Response(await this.exportFile(), { headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && action === "restore") return this.restore(request);
    return new Response("Not found", { status: 404 });
  }

  /** The export as a file: deterministic, so the same data always gives the same bytes. */
  private async exportFile(): Promise<string> {
    return `${JSON.stringify(exportHousehold(this.ctx.storage.sql, await this.photoKeys()), null, 2)}\n`;
  }

  private async restore(request: Request): Promise<Response> {
    // A JSON content type needs a CORS preflight, so another site cannot submit a restore form.
    if (request.headers.get("Content-Type")?.split(";")[0]?.trim() !== "application/json") {
      return Response.json({ code: "invalid_export", message: "Send the export as application/json" }, { status: 415 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ code: "invalid_export", message: "The body is not JSON" }, { status: 400 });
    }
    const result = restoreHousehold(this.ctx.storage, body);
    if (!result.ok) return Response.json(result.error, { status: RESTORE_STATUS[result.error.code] });

    const revision = this.bumpRevision();
    for (const topic of ChangeTopic.options) this.notify(topic, revision);
    await this.scheduleNightlyExport();
    return Response.json({ ok: true });
  }

  /**
   * Keeps exactly one upcoming export, at the next 03:00 in the Household's timezone. Only future
   * runs are reconciled, so the run in progress is left for the scheduler to complete.
   */
  private async scheduleNightlyExport(): Promise<void> {
    const household = this.household();
    const now = new Date();
    const upcoming = (await this.listSchedules()).filter(
      (schedule) => schedule.callback === "nightlyExport" && schedule.time * 1000 > now.getTime(),
    );
    const next = household && nextOccurrence(now, NIGHTLY_EXPORT_TIME, household.timezone);
    if (next && upcoming.length === 1 && upcoming[0]?.time === next.getTime() / 1000) return;

    for (const schedule of upcoming) await this.cancelSchedule(schedule.id);
    if (next) await this.schedule(next, "nightlyExport");
  }

  /** The caller over a WebSocket; RPC from inside the deployment (tests, scheduled jobs) has none. */
  private callerOf(connection: Connection | undefined): Caller | null {
    return (connection?.state as ConnectionState | null | undefined)?.caller ?? null;
  }

  private household(): HouseholdData | null {
    const result = handlers.get_household(this.ctx.storage.sql, {}, { caller: null });
    return result.ok ? result.value : null;
  }

  private async photoKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.env.BUCKET.list({ prefix: PHOTO_PREFIX, cursor });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  private notify(topic: ChangeTopic, revision: number): void {
    this.broadcast(JSON.stringify({ type: "mise:change", topic, revision } satisfies ChangeNotice));
  }

  private bumpRevision(): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>("UPDATE revision SET value = value + 1 WHERE id = 1 RETURNING value")
      .one().value;
  }
}

/** Errors, traces and Agent events go to Sentry, scrubbed of Household data. */
export const Household = Sentry.instrumentAgentWithSentry(sentryOptions, HouseholdAgent);
export type Household = HouseholdAgent;
