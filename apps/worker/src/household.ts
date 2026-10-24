import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import {
  type Caller,
  type ChangeNotice,
  ChangeTopic,
  ChatInput,
  type ChatMessage,
  type ChatReply,
  changeTopicOf,
  exportKey,
  type Household as HouseholdData,
  type ImportError,
  type ImportedPhoto,
  type ImportRun,
  importUploadKey,
  isToolName,
  localDate,
  NIGHTLY_EXPORT_TIME,
  nextOccurrence,
  type ParsedToolInput,
  PHOTO_PREFIX,
  parseToolInput,
  type Recipe,
  readPaprikaExport,
  type ToolContext,
  type ToolName,
  type ToolResult,
} from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { agentModels, miseExtension, recentChat } from "./agent";
import { exportHousehold, type RestoreError, restoreHousehold } from "./backup";
import { readCalendarFeed } from "./calendar";
import { callerFrom } from "./identity";
import { type PreparedRecipe, runImport } from "./imports";
import { migrate } from "./migrations";
import { sentryOptions } from "./observability";
import { photoInUse, photoKeyOf, setPhotoKey } from "./recipes";
import { handlers } from "./tools";

/** The image types a Recipe photo may be, and the largest one accepted. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** The largest export accepted: what a Worker can be sent, and what the household can hold in memory. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Not a type a form can send, so another site needs a CORS preflight, which is refused (ADR 0011). */
const UPLOAD_TYPES = new Set(["application/octet-stream", "application/zip"]);

/** How many of the conversation's latest turns the chat shows. */
const RECENT_CHAT_TURNS = 100;

const RESTORE_STATUS: Record<RestoreError["code"], number> = {
  invalid_export: 400,
  schema_mismatch: 409,
  not_empty: 409,
};

/** What the household remembers about each WebSocket; it survives hibernation. */
type ConnectionState = { caller: Caller | null };

/** The household Durable Object: the one place Mise's data lives. */
class HouseholdAgent extends Agent<Env> {
  private readonly models = agentModels(this.env);

  /**
   * The agent: one shared Pi conversation, kept in Pi's own `pi_` tables beside ours. It reaches
   * Mise's data only through the tools, called as the PWA calls them.
   */
  private readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const registry = createRegistry();
      // As no one for now: which Member is speaking reaches the tools with the speaker records (#31, story 45).
      registry.install(miseExtension((name, input) => this.invokeTool(name, input, null)));
      return Harness.open(
        storage,
        // A failed run answers nothing more: later messages are not run against a stale question.
        { models: this.models.models, registry, onWake, settings: { afterFailedRun: "withdraw" } },
        context,
      );
    },
    defaults: { model: this.models.model },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs before any request, RPC call or WebSocket message is served.
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    this.lifecycle.use(this.harness);
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
    return this.invokeTool(name, input, this.callerOf(getCurrentAgent().connection));
  }

  /** Sends a Member's message to the agent and waits for its answer. */
  @callable()
  async chat(text: unknown): Promise<ChatReply> {
    const message = ChatInput.safeParse(text);
    if (!message.success)
      return { ok: false, error: { code: "invalid_input", message: "Send a message to the agent" } };
    const answer = await this.harness.prompt(message.data);
    if (answer.status !== "done") {
      return { ok: false, error: { code: "unanswered", message: answer.reason ?? "The agent did not answer" } };
    }
    return { ok: true, value: { role: "agent", text: answer.text ?? "" } };
  }

  /** The latest turns of the Household's conversation with the agent, oldest first. */
  @callable()
  async conversation(): Promise<ChatMessage[]> {
    // The harness opened Pi with its root conversation, so `root` finds it rather than making one.
    const pi = await this.harness.pi();
    return recentChat(await pi.root(BACKGROUND_CONTEXT), RECENT_CHAT_TURNS);
  }

  /** A tool call, as `caller`; the agent's calls come here too. */
  private async invokeTool(name: string, input: unknown, caller: Caller | null): Promise<ToolResult<unknown>> {
    // One span per tool, named but without its input: inputs are Household data.
    const spanName = `tool ${isToolName(name) ? name : "unknown"}`;
    return Sentry.startSpan({ name: spanName, op: "mise.tool" }, () => this.runTool(name, input, caller));
  }

  private async runTool(name: string, input: unknown, caller: Caller | null): Promise<ToolResult<unknown>> {
    const parsed = parseToolInput(name, input);
    if (!parsed.ok) return parsed;
    if (name === "run_paprika_import") {
      return this.runPaprikaImport(parsed.value as ParsedToolInput<"run_paprika_import">);
    }
    const toolName = name as Exclude<ToolName, "run_paprika_import">;
    const handler = handlers[toolName] as (
      sql: SqlStorage,
      input: unknown,
      context: ToolContext,
    ) => ToolResult<unknown>;
    const context: ToolContext = { caller };
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

  /**
   * Imports an uploaded Paprika export. Photos go to R2 first, keyed by their content, so the same
   * photo is stored once however often it is imported; then every Recipe is upserted in one
   * transaction. Photos nothing shows any more are deleted after it commits, and so is the upload.
   */
  private async runPaprikaImport(input: ParsedToolInput<"run_paprika_import">): Promise<ToolResult<ImportRun>> {
    const uploadKey = importUploadKey(input.upload);
    const upload = await this.env.BUCKET.get(uploadKey);
    if (!upload) return { ok: false, error: { code: "not_found", message: "No uploaded export with that id" } };
    const startedAt = new Date().toISOString();
    const { sql } = this.ctx.storage;

    const prepared: PreparedRecipe[] = [];
    const errors: ImportError[] = [];
    const stored: string[] = [];
    const entries = readPaprikaExport(new Uint8Array(await upload.arrayBuffer()));
    if (!entries) errors.push({ entry: null, message: "The file is not a Paprika export (.paprikarecipes)" });
    for await (const entry of entries ?? []) {
      if (!entry.ok) {
        errors.push({ entry: entry.entry, message: entry.error });
        continue;
      }
      const { recipe, photo } = entry;
      let photoError = entry.photoError;
      if (photo && photo.bytes.byteLength > MAX_PHOTO_BYTES) photoError = "The photo is larger than 10 MB";
      if (photoError) errors.push({ entry: entry.entry, message: photoError });
      // An unchanged Recipe is skipped, so its photo is not stored again.
      const unchanged =
        sql
          .exec(
            "SELECT 1 FROM recipe WHERE source_kind = 'paprika' AND source_id = ? AND source_revision = ?",
            recipe.externalId,
            recipe.revision,
          )
          .toArray().length > 0;
      let photoKey: string | null | undefined = null;
      if (photoError || unchanged) photoKey = undefined;
      else if (photo) photoKey = await this.storeImportedPhoto(photo, stored);
      prepared.push({ recipe, photoKey });
    }

    const outcome = this.ctx.storage.transactionSync(() => ({
      ...runImport(sql, "paprika", startedAt, prepared, errors),
      revision: this.bumpRevision(),
    }));
    this.notify("recipes", outcome.revision);
    // Photos the updated Recipes replaced, and new ones a Recipe flagged for a merge did not take.
    for (const key of [...outcome.replacedPhotos, ...stored]) await this.deletePhoto(key);
    await this.env.BUCKET.delete(uploadKey);
    return { ok: true, value: outcome.run };
  }

  /** Stores an imported photo under its SHA-256 unless already there; returns its key. */
  private async storeImportedPhoto(photo: ImportedPhoto, stored: string[]): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", photo.bytes));
    const key = `${PHOTO_PREFIX}sha256-${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    if (!(await this.env.BUCKET.head(key))) {
      await this.env.BUCKET.put(key, photo.bytes, { httpMetadata: { contentType: photo.type } });
      stored.push(key);
    }
    return key;
  }

  /**
   * The Calendar Feed for `token`, or null if it is not the current one. Called by the Worker over
   * RPC for `/cal/<token>.ics`, which bypasses Access (ADR 0019); never callable over the WebSocket.
   */
  async calendarFeed(token: string, origin: string): Promise<string | null> {
    return readCalendarFeed(this.ctx.storage.sql, token, origin, new Date());
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
   * as the body) and `DELETE …/recipes/<id>/photo`. A Paprika export, for `run_paprika_import` to
   * import (ADR 0011): `PUT …/imports/paprika`.
   */
  override async onRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const photo = /\/recipes\/(\d+)\/photo$/.exec(pathname);
    if (photo) return this.photo(request, Number(photo[1]));
    if (pathname.endsWith("/imports/paprika")) return this.uploadExport(request);
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

  /** Keeps an uploaded export in R2 under a new id, which `run_paprika_import` is then given. */
  private async uploadExport(request: Request): Promise<Response> {
    if (request.method !== "PUT") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "PUT" } });
    }
    const type = request.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
    if (!UPLOAD_TYPES.has(type)) return new Response("Send the export as application/octet-stream", { status: 415 });
    const file = await request.arrayBuffer();
    if (file.byteLength > MAX_UPLOAD_BYTES) return new Response("The export is larger than 100 MB", { status: 413 });
    const upload = crypto.randomUUID();
    await this.env.BUCKET.put(importUploadKey(upload), file);
    return Response.json({ ok: true, upload });
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

  /** Deletes a photo from R2 unless a Recipe still shows it (imported photos can be shared). */
  private async deletePhoto(key: string | null): Promise<void> {
    if (key && !photoInUse(this.ctx.storage.sql, key)) await this.env.BUCKET.delete(key);
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
