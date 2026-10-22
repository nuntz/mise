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
  type Recipe,
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
import { photoKeyOf, setPhotoKey } from "./recipes";
import { handlers } from "./tools";

/** The image types a Recipe photo may be, and the largest one accepted. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

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

    let outcome: { result: ToolResult<unknown>; revision?: number };
    try {
      outcome = this.ctx.storage.transactionSync(() => {
        const result = handler(this.ctx.storage.sql, parsed.value, context);
        // Thrown so that a handler refusing part-way through leaves nothing behind.
        if (!result.ok) throw new Rejected(result);
        return { result, revision: topic && this.bumpRevision() };
      });
    } catch (error) {
      if (error instanceof Rejected) return error.result;
      throw error;
    }
    const { result, revision } = outcome;

    if (topic && revision !== undefined) {
      this.notify(topic, revision);
      // The Household's timezone decides when the export runs.
      if (topic === "household") await this.scheduleNightlyExport();
    }
    // Photos live in R2, outside the transaction: a deleted Recipe's goes once the deletion is committed.
    if (toolName === "delete_recipe" && result.ok) await this.deletePhoto((result.value as Recipe).photoKey);
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

  /**
   * Backup over HTTP: `GET …/export` downloads the export, `POST …/restore` loads one into an empty
   * household. Recipe photos, which are too big for a tool call (ADR 0010): `GET`, `PUT` (the image
   * as the body) and `DELETE …/recipes/<id>/photo`.
   */
  override async onRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const photo = /\/recipes\/(\d+)\/photo$/.exec(pathname);
    if (photo) return this.photo(request, Number(photo[1]));
    const action = pathname.split("/").at(-1);
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

  private async photo(request: Request, recipeId: number): Promise<Response> {
    const { sql } = this.ctx.storage;
    if (request.method === "GET") {
      const key = photoKeyOf(sql, recipeId);
      const object = key ? await this.env.BUCKET.get(key) : null;
      if (!object) return new Response("Not found", { status: 404 });
      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
          "Cache-Control": "private, no-cache",
          ETag: object.httpEtag,
        },
      });
    }
    if (request.method === "PUT") {
      const type = request.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
      if (!PHOTO_TYPES.has(type)) return new Response("Send a JPEG, PNG, WebP, GIF or AVIF image", { status: 415 });
      if (photoKeyOf(sql, recipeId) === undefined) return new Response("No such Recipe", { status: 404 });
      const image = await request.arrayBuffer();
      if (image.byteLength > MAX_PHOTO_BYTES) return new Response("The photo is larger than 10 MB", { status: 413 });
      const key = `${PHOTO_PREFIX}recipe-${recipeId}-${crypto.randomUUID()}`;
      await this.env.BUCKET.put(key, image, { httpMetadata: { contentType: type } });
      // The Recipe may have been deleted while the photo uploaded.
      if (!(await this.changePhoto(recipeId, key))) {
        await this.deletePhoto(key);
        return new Response("No such Recipe", { status: 404 });
      }
      return Response.json({ ok: true, photoKey: key });
    }
    if (request.method === "DELETE") {
      if (!(await this.changePhoto(recipeId, null))) return new Response("No such Recipe", { status: 404 });
      return Response.json({ ok: true });
    }
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, PUT, DELETE" } });
  }

  /** Points a Recipe at a new photo (or none) and deletes the old one. False if there is no such Recipe. */
  private async changePhoto(recipeId: number, key: string | null): Promise<boolean> {
    const changed = this.ctx.storage.transactionSync(() => {
      const set = setPhotoKey(this.ctx.storage.sql, recipeId, key);
      return set && { previous: set.previous, revision: this.bumpRevision() };
    });
    if (!changed) return false;
    this.notify("recipes", changed.revision);
    await this.deletePhoto(changed.previous);
    return true;
  }

  private async deletePhoto(key: string | null): Promise<void> {
    if (key) await this.env.BUCKET.delete(key);
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

/** A tool's refusal, carried out of the transaction it rolls back. */
class Rejected extends Error {
  constructor(readonly result: ToolResult<unknown>) {
    super("Tool call refused");
  }
}

/** Errors, traces and Agent events go to Sentry, scrubbed of Household data. */
export const Household = Sentry.instrumentAgentWithSentry(sentryOptions, HouseholdAgent);
export type Household = HouseholdAgent;
