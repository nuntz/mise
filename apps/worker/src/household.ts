import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, createRegistry, Harness } from "@earendil-works/pi-durable";
import {
  addDays,
  BACKUP_PREFIX,
  backupsToPrune,
  type Caller,
  type ChangeNotice,
  ChangeTopic,
  ChatInput,
  type ChatMessage,
  type ChatReply,
  ChatWhere,
  type Cooking,
  changeTopicOf,
  checkInMessage,
  DRIVE_SYNC_TIME,
  type DriveDoc,
  type DriveSyncStarted,
  docLink,
  docText,
  driveFlaggedMessage,
  exportKey,
  firstDocImage,
  type Household as HouseholdData,
  type ImportError,
  type ImportedPhoto,
  type ImportedRecipe,
  type ImportRun,
  type ImportSource,
  imageType,
  importedFromDoc,
  importedFromScreenshots,
  importedFromText,
  importUploadKey,
  isLinkOnly,
  isScreenshotType,
  isStarted,
  isToolName,
  type Llm,
  LlmError,
  type LocalDate,
  localDate,
  MAX_PASTED_TEXT,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOTS_BYTES,
  MORNING_PUSH_TIME,
  NIGHTLY_EXPORT_TIME,
  nextOccurrence,
  type ParsedToolInput,
  PHOTO_PREFIX,
  ProposeWeekInput,
  type PushKey,
  type PushMessage,
  parseToolInput,
  prepAheadDue,
  prepAheadMessage,
  presentTurn,
  proposalWeekOn,
  proposedMessage,
  type Recipe,
  type RecipeId,
  type RecipeImage,
  type RecipeReading,
  type ResolvedCaller,
  readPaprikaExport,
  reviewMessage,
  type ShowStep,
  type Staple,
  type Suggestion,
  screenshotUploadKey,
  suggestItems,
  type ToolContext,
  type ToolName,
  type ToolOutput,
  type ToolResult,
  thisAndNextWeek,
  VOICE_START_CHARGE_SECONDS,
  type VoiceAvailability,
  type VoiceStartReply,
  type Week,
} from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from "agents";
import { PiHarness } from "agents/harness/pi";
import {
  type AgentCallResult,
  agentCompaction,
  agentModels,
  confirmationsSince,
  keepUnansweredMarked,
  miseExtension,
  recentChat,
  TURN_ENTRY,
  type TurnData,
  turnBeingAnswered,
} from "./agent";
import { type AgentLog, agentLog, recordExchange } from "./agentLog";
import { exportHousehold, type RestoreError, restoreHousehold } from "./backup";
import { readCalendarFeed, readPrepAhead } from "./calendar";
import {
  confirmationShown,
  holdIfGuarded,
  pendingConfirmations,
  releaseConfirmation,
  takeConfirmation,
} from "./confirmations";
import { type Drive, DriveError, driveRevision, openDrive, recordDriveDocs } from "./drive";
import { callerFrom } from "./identity";
import { fillDraft, isUnchanged, type PreparedRecipe, readRecipeFrom, runImport } from "./imports";
import { readCatalogue } from "./items";
import { type DaySheetAnswer, readDaySheet } from "./kitchenDisplays";
import { fetchPhoto, readLink } from "./links";
import { type Live, LiveError, openLive } from "./live";
import { openLlm } from "./llm";
import { countRows, meterQueries, queuedMs, rowAttributes } from "./metering";
import { migrate } from "./migrations";
import { piReports, reportWakeErrors, sentryOptions, sentryTelemetry } from "./observability";
import { openPush, PushError } from "./push";
import { removePushSubscription, subscriptionsFor } from "./pushDevices";
import { photoInUse, photoKeyOf, readRecipe, setPhotoKey } from "./recipes";
import { newTextsIn, remainingToSuggest, storeSuggestions, textsToSuggest } from "./suggestions";
import { type HouseholdToolName, handlers } from "./tools";
import { callerOfTurn, recordTurn, speakerName, speakerOfTurn } from "./turns";
import { VoiceSession } from "./voice";
import { endCutShortVoiceSessions, recordVoiceUsage, voiceSecondsOn } from "./voiceUsage";
import { readSlots } from "./weeks";

/** The image types a Recipe photo may be, and the largest one accepted. */
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** The largest export accepted: what a Worker can be sent, and what the household can hold in memory. */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Not a type a form can send, so another site needs a CORS preflight, which is refused (ADR 0011). */
const UPLOAD_TYPES = new Set(["application/octet-stream", "application/zip"]);

/**
 * The most Docs one Drive sync reads: each is a request to the model, and a sync must finish well
 * within the time a scheduled run is given. The rest are read by the next sync.
 */
const MAX_DOCS_PER_SYNC = 25;

/** How many of the conversation's latest turns the chat shows. */
const RECENT_CHAT_TURNS = 100;

const RESTORE_STATUS: Record<RestoreError["code"], number> = {
  invalid_export: 400,
  schema_mismatch: 409,
  not_empty: 409,
};

// Once per isolate: the channel is shared by every Household it runs.
reportWakeErrors();

/** The most keys one R2 delete takes. */
const R2_DELETE_LIMIT = 1000;

/** The scheduler callbacks the household runs once a day. */
type DailyRun = "nightlyExport" | "nightlyDriveSync" | "morningPushes";
/** Every scheduler callback the household runs. */
type ScheduledRun = DailyRun | "askedDriveSync" | "suggestAfterImport";

/** What the household remembers about each WebSocket; it survives hibernation. */
type ConnectionState = { caller: Caller | null };

/** The household Durable Object: the one place Mise's data lives. */
class HouseholdAgent extends Agent<Env> {
  private readonly models = agentModels(this.env);
  /**
   * This instance of the Household, on every span it sends: a wake after eviction, or a reset,
   * starts a new one, so spans tell an instance that was stuck from one that was gone.
   */
  private readonly instance = crypto.randomUUID().slice(0, 8);
  /** The Drive sync running, if one is: the nightly sync joins one asked for, and the other way round. */
  private driveSync: Promise<ImportRun> | null = null;
  /** Whether "Sync Drive now" has scheduled a sync that has not finished, so that asking again starts none. */
  private driveSyncAsked = false;

  /**
   * The agent: one shared Pi conversation, kept in Pi's own `pi_` tables beside ours. It reaches
   * Mise's data only through the tools, called as the PWA calls them, as the Member whose turn it answers.
   */
  private readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const registry = createRegistry();
      registry.install(
        miseExtension({
          callTool: (name, input, caller) => this.invokeTool(name, input, caller, "agent"),
          speakerIn: (id) => this.callerAnswered(id),
          showStep: (step, id) => this.showStep(step, id),
          answersSpoken: (id) => this.answersSpoken(id),
        }),
      );
      return Harness.open(
        storage,
        {
          models: this.models.models,
          registry,
          onWake,
          settings: {
            // A failed run answers nothing more: later messages are not run against a stale question. That
            // holds for every speaker's: another Member's queued message is withdrawn too, and they resend it.
            afterFailedRun: "withdraw",
            // One queued turn per run, so that a run's tools find its own speaker (`turnBeingAnswered`).
            followUpMode: "one-at-a-time",
            compaction: agentCompaction(this.models),
            // A round's tool calls run in the order the model made them: a dinner kept before a Re-roll
            // stays. They are quick calls to this household, so nothing is lost.
            toolExecution: "sequential",
          },
          // Runs and model requests are traced, and pi's own failures reported, without what anyone said.
          telemetry: sentryTelemetry(),
          onReport: piReports(),
        },
        context,
      );
    },
    defaults: { model: this.models.model },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    meterQueries(ctx.storage.sql);
    // Runs before any request, RPC call or WebSocket message is served.
    // Not traced: Sentry isn't set up for the invocation yet, so a span started here is never sent.
    void ctx.blockConcurrencyWhile(async () => migrate(ctx.storage));
    this.lifecycle.use(this.harness);
  }

  override async onStart(): Promise<void> {
    await this.traced("household start", "mise.start", async (span) => {
      span.setAttribute("mise.database_bytes", this.ctx.storage.sql.databaseSize);
      // The Voice Session a restart or deploy cut short isn't reattached: screens are told voice ended.
      if (endCutShortVoiceSessions(this.ctx.storage.sql)) this.notify("voice", this.revision());
      await this.followAgentModel();
      await this.scheduleDailyRuns();
    });
  }

  /**
   * `work` in a span of its own, with the rows it read and wrote: its duration counts only the time
   * it waited on I/O, as the clock stands still while synchronous code runs. The invocation's spans
   * are tagged with this instance.
   */
  private traced<T>(name: string, op: string, work: (span: Sentry.Span) => Promise<T> | T): Promise<T> {
    this.tagInstance();
    return Sentry.startSpan({ name, op }, (span) =>
      countRows(
        () => work(span),
        (rows) => span.setAttributes(rowAttributes(rows)),
      ),
    );
  }

  /** Tags every span of the invocation running now (its request, message or alarm) with this instance. */
  private tagInstance(): void {
    Sentry.getIsolationScope().setAttribute("mise.instance", this.instance);
  }

  /**
   * Puts the conversation on the agent's model if a deploy changed it: Pi keeps the model a
   * conversation began on, and the harness's default applies only to a new one.
   */
  private async followAgentModel(): Promise<void> {
    const { model } = this.models;
    const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT);
    const current = (await root.agent(BACKGROUND_CONTEXT)).model;
    if (current?.provider === model.provider && current.modelId === model.id) return;
    await this.harness.session().setModel(model);
  }

  /** Remembers who opened the connection, as the Worker resolved them, for every tool call it makes. */
  override async onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext): Promise<void> {
    this.tagInstance();
    connection.setState({ caller: callerFrom(ctx.request) });
    await super.onConnect(connection, ctx);
  }

  /**
   * The single entry point to every tool (ADR 0002). Input is validated against the registry. A
   * screen also sends when it sent the call (`sentAt`, ms since the epoch), so that its span shows
   * whether the call queued behind the Household's other work (see `queuedMs`).
   */
  @callable()
  async callTool(name: string, input: unknown, sentAt?: unknown): Promise<ToolResult<unknown>> {
    const queued = queuedMs(sentAt, Date.now());
    return this.invokeTool(name, input, this.callerOf(getCurrentAgent().connection), "client", queued);
  }

  /**
   * Sends a Member's message to the agent, from the screen and Week `where` names, and waits for its
   * answer. The turn is recorded with its Caller and shown to the model with who said it; a turn sent
   * while another is answered waits for it. Every screen is told once the conversation has grown.
   */
  @callable()
  async chat(text: unknown, where: unknown): Promise<ChatReply> {
    const message = ChatInput.safeParse(text);
    const from = ChatWhere.safeParse(where);
    if (!message.success || !from.success) {
      return { ok: false, error: { code: "invalid_input", message: "Send a message to the agent" } };
    }
    const { reply } = await this.answerTurn(
      this.callerOf(getCurrentAgent().connection),
      message.data,
      from.data,
      false,
    );
    return reply;
  }

  /**
   * A turn of the shared conversation from `who`, typed in the chat or `spoken` in a Voice Session:
   * the agent's answer, and the turn as recorded.
   */
  private async answerTurn(
    who: Caller | null,
    text: string,
    where: ChatWhere,
    spoken: boolean,
  ): Promise<{ reply: ChatReply; turn: number }> {
    const { sql } = this.ctx.storage;
    const speaker = this.resolvedCaller(who);
    const now = new Date();
    const turn = recordTurn(sql, speaker, now.toISOString());
    if (spoken) this.spokenTurns.add(turn);
    // Before the Household is set up there is no timezone yet: UTC's day is the nearest guess.
    const household = this.household();
    const today = localDate(now, household?.timezone ?? "UTC");
    // After a failed run, the turns it left waiting aren't answered with this one.
    const pi = await this.harness.pi();
    const afterUnanswered = await keepUnansweredMarked(pi, await pi.root(BACKGROUND_CONTEXT));
    const presented = presentTurn({
      speaker: speakerOfTurn(sql, turn),
      today,
      where,
      cooking: this.cookingAt(where),
      checkIn: spoken && where.screen === "pantry" ? this.dueStaples() : undefined,
      spoken,
      afterUnanswered,
      waiting: pendingConfirmations(sql),
      week: this.weekShownAt(where),
      thisAndNext: household ? thisAndNextWeek(today, household) : undefined,
      text,
    });
    const entry: TurnData = { turn, text };
    // `wait` gives the answer's text; `prompt` would also read the whole transcript after every turn.
    const answer = await Sentry.startSpan({ name: "agent run", op: "mise.agent" }, async () => {
      const { operationId } = await this.harness.submit(presented, { entry: { kind: TURN_ENTRY, data: entry } });
      return this.harness.wait(operationId);
    }).finally(() => this.spokenTurns.delete(turn));
    this.notify("chat", this.bumpRevision());
    if (answer.status !== "done") {
      const message = answer.reason ?? "The agent did not answer";
      return { reply: { ok: false, error: { code: "unanswered", message } }, turn };
    }
    return { reply: { ok: true, value: { role: "agent", text: answer.text ?? "" } }, turn };
  }

  /**
   * The Recipe Kitchen mode cooks at `where`, scaled as it shows it: to its Slot's servings, Leftovers
   * included, while the Slot still holds it, or as written. None outside Kitchen mode, or once the
   * Recipe is gone.
   */
  private cookingAt(where: ChatWhere): Cooking | undefined {
    if (where.screen !== "kitchen") return undefined;
    const { sql } = this.ctx.storage;
    const recipe = handlers.get_recipe(sql, { id: where.recipe }, { caller: null });
    const household = this.household();
    if (!recipe.ok || !household) return undefined;
    let servings = recipe.value.baseServings;
    if (where.slot) {
      const { date, meal } = where.slot;
      const week = handlers.get_week(sql, { date }, { caller: null });
      const slot = week.ok ? week.value.slots.find((one) => one.date === date && one.meal === meal) : undefined;
      if (slot?.recipe?.id === where.recipe && slot.cookFor > 0) servings = slot.cookFor;
    }
    return { recipe: recipe.value, servings, locale: household.locale };
  }

  /** The Week the Week screen shows at `where`, as it is now; none from any other screen. */
  private weekShownAt(where: ChatWhere): Week | undefined {
    if (where.screen !== "week" || !where.week) return undefined;
    const week = handlers.get_week(this.ctx.storage.sql, { date: where.week }, { caller: null });
    return week.ok ? week.value : undefined;
  }

  /** The Staples a Check-in asks about now, in the order the Pantry's cards ask about them. */
  private dueStaples(): Staple[] {
    const due = handlers.list_due_staples(this.ctx.storage.sql, {}, { caller: null });
    return due.ok ? due.value.staples : [];
  }

  /** The spoken turns being answered: only their runs may move Kitchen mode's screen. */
  private readonly spokenTurns = new Set<number>();

  /**
   * Moves Kitchen mode to `step` on the device the Voice Session talks through, and on no other: the
   * agent read it aloud, answering a spoken turn in the `conversation`. A typed turn, from another
   * device, never moves the cook's screen. The next turn is heard from the step, before the screen
   * says it moved. Resolves with the step shown, at most the Recipe's last; null without a session
   * from Kitchen mode.
   */
  private async showStep(step: number, conversation: ConversationId): Promise<number | null> {
    if (!(await this.answersSpoken(conversation))) return null;
    const session = this.voice;
    if (!(session instanceof VoiceSession) || !this.voiceConnection) return null;
    const { where } = session;
    const steps = this.cookingAt(where)?.recipe.steps.length ?? 0;
    const connection = this.getConnection(this.voiceConnection);
    if (where.screen !== "kitchen" || steps === 0 || !connection) return null;
    const shown = Math.min(step, steps);
    connection.send(JSON.stringify({ type: "mise:show-step", step: shown } satisfies ShowStep));
    session.moveTo({ ...where, step: shown });
    return shown;
  }

  /** Whether the `conversation` is answering one of the spoken turns. */
  private async answersSpoken(conversation: ConversationId): Promise<boolean> {
    const answering = await (await this.harness.pi()).conversation(conversation, BACKGROUND_CONTEXT);
    const turn = answering && (await turnBeingAnswered(answering));
    return !!turn && this.spokenTurns.has(turn);
  }

  /** What the buttons say of the confirmations held since `turn` that still wait for a tap. */
  private async heldButtonsSince(turn: number): Promise<string[]> {
    const { sql } = this.ctx.storage;
    const ids = await confirmationsSince(await (await this.harness.pi()).root(BACKGROUND_CONTEXT), turn);
    return ids.flatMap((id) => {
      const shown = confirmationShown(sql, id);
      return shown?.status === "pending" ? [shown.summary] : [];
    });
  }

  /**
   * The Household's Voice Session, if one runs or is starting: one at a time, held in memory (ADR
   * 0028). A start asked to end while it waits on OpenAI ends the session once it has one.
   */
  private voice: VoiceSession | { starting: true; cancelled: boolean; where: ChatWhere } | null = null;
  /** The connection that started the Voice Session: the device the person talks through. */
  private voiceConnection: string | undefined;
  /** Who is talking to Mise in the Voice Session, as their turns name them. */
  private voiceSpeaker: string | null = null;

  /** Whether a Voice Session could start now, for the mic to say before anyone taps it. */
  @callable()
  async voiceAvailability(): Promise<VoiceAvailability> {
    const ready = this.voiceReadiness(new Date());
    if (ready.status === "not_set_up") return { status: "unavailable" };
    if (ready.status === "available") return { status: "available" };
    if (ready.status === "in_use") {
      const asker = getCurrentAgent().connection?.id;
      return { ...ready, yours: asker !== undefined && asker === this.voiceConnection };
    }
    return ready;
  }

  /**
   * Whether a Voice Session could start at `now`, in the order a start is refused: on a deployment
   * without an OpenAI key, while another session runs, before the Household is set up, with a cap of
   * 0, and once the day's voice minutes are spent, with when they come back. When it could, the Live
   * to start it on, the day it counts toward and the seconds that day has left.
   */
  private voiceReadiness(
    now: Date,
  ):
    | Exclude<VoiceAvailability, { status: "available" | "in_use" }>
    | { status: "in_use"; by: string | null }
    | { status: "not_set_up" }
    | { status: "available"; live: Live; day: LocalDate; left: number } {
    const live = openLive(this.env);
    if (!live) return { status: "unavailable" };
    if (this.voice) return { status: "in_use", by: this.voiceSpeaker };
    const household = this.household();
    if (!household) return { status: "not_set_up" };
    if (household.voiceMinutesPerDay === 0) return { status: "off" };
    // A session counts toward the day it started on, even if it runs past midnight.
    const day = localDate(now, household.timezone);
    const left = household.voiceMinutesPerDay * 60 - voiceSecondsOn(this.ctx.storage.sql, day);
    if (left < VOICE_START_CHARGE_SECONDS) {
      return { status: "spent", until: nextOccurrence(now, "00:00", household.timezone).toISOString() };
    }
    return { status: "available", live, day, left };
  }

  /**
   * Starts a Voice Session from the browser's WebRTC offer, sent from the screen and Week `where`
   * names, and resolves with the SDP answer. Each turn heard is the starting Caller's, through the
   * same path as `chat`, spoken from where `moveVoice` last said the person was. Refused to a
   * request with no Caller, and whenever `voiceAvailability` says voice isn't available. Every
   * device is told when a session starts and when it ends.
   */
  @callable()
  async startVoice(offer: unknown, where: unknown): Promise<VoiceStartReply> {
    const { connection } = getCurrentAgent();
    const caller = this.callerOf(connection);
    const from = ChatWhere.safeParse(where);
    if (typeof offer !== "string" || !offer.trim() || !from.success) {
      return { ok: false, error: { code: "invalid_input", message: "Send a WebRTC offer and where it was sent from" } };
    }
    if (!caller) return { ok: false, error: { code: "not_signed_in", message: "Sign in to talk to Mise" } };
    const ready = this.voiceReadiness(new Date());
    switch (ready.status) {
      case "unavailable":
        return { ok: false, error: { code: "unavailable", message: "This deployment has no OpenAI key" } };
      case "in_use":
        return { ok: false, error: { code: "in_use", message: "Someone is already talking to Mise", by: ready.by } };
      case "not_set_up":
        return { ok: false, error: { code: "not_set_up", message: "Set up the Household first" } };
      case "off":
        return { ok: false, error: { code: "off", message: "Voice is turned off in the Household's settings" } };
      case "spent":
        return {
          ok: false,
          error: { code: "spent", message: "Today's voice minutes are used up", until: ready.until },
        };
    }
    const { live, day, left } = ready;
    const { sql } = this.ctx.storage;
    // Claimed before the first await, so that a second start finds it taken.
    const starting = { starting: true as const, cancelled: false, where: from.data };
    this.voice = starting;
    this.voiceConnection = connection?.id;
    this.voiceSpeaker = speakerName(this.resolvedCaller(caller));
    this.notify("voice", this.revision());
    try {
      const { session, sdp } = await VoiceSession.start(
        live,
        offer,
        from.data,
        {
          answer: async (text, where) =>
            Sentry.startSpan({ name: "voice turn", op: "mise.voice" }, async () => {
              const { reply, turn } = await this.answerTurn(caller, text, where, true);
              if (!reply.ok) return { turn, reply: null };
              return { turn, reply: { text: reply.value.text, held: await this.heldButtonsSince(turn) } };
            }),
          exchange: (exchange) => recordExchange(sql, exchange),
          usage: (usage) => recordVoiceUsage(sql, day, usage),
          end: (ended) => {
            if (this.voice === ended) this.releaseVoice();
          },
        },
        left,
      );
      if (starting.cancelled) {
        session.end();
        this.releaseVoice();
        return { ok: false, error: { code: "not_started", message: "The Voice Session was ended while it started" } };
      }
      // A sideband that closed while starting has ended the session already.
      if (session.running) this.voice = session;
      else this.releaseVoice();
      session.moveTo(starting.where);
      return { ok: true, value: { sdp } };
    } catch (error) {
      this.releaseVoice();
      if (error instanceof LiveError) return { ok: false, error: { code: "not_started", message: error.message } };
      throw error;
    }
  }

  /** Lets go of the Household's Voice Session, and tells every device that voice is free. */
  private releaseVoice(): void {
    this.voice = null;
    this.voiceSpeaker = null;
    this.notify("voice", this.revision());
  }

  /**
   * Tells the Household's Voice Session, if one runs or is starting, that the person is now on the
   * screen and Week `where` names, as the browser sees each change. Only the connection that started
   * it may move it. Resolves with whether it was taken.
   */
  @callable()
  async moveVoice(where: unknown): Promise<boolean> {
    const to = ChatWhere.safeParse(where);
    const mover = getCurrentAgent().connection?.id;
    if (!to.success || !this.voice || !mover || mover !== this.voiceConnection) return false;
    if (this.voice instanceof VoiceSession) this.voice.moveTo(to.data);
    else this.voice.where = to.data;
    return true;
  }

  /** Ends the Household's Voice Session, if one runs or is starting. */
  @callable()
  async endVoice(): Promise<void> {
    if (this.voice instanceof VoiceSession) this.voice.end();
    else if (this.voice) this.voice.cancelled = true;
  }

  /** The Caller whose turn the conversation `id` is answering. */
  private async callerAnswered(id: ConversationId): Promise<Caller | null> {
    const conversation = await (await this.harness.pi()).conversation(id, BACKGROUND_CONTEXT);
    const turn = conversation && (await turnBeingAnswered(conversation));
    return turn ? callerOfTurn(this.ctx.storage.sql, turn) : null;
  }

  /** The latest turns of the Household's conversation with the agent, oldest first. */
  @callable()
  async conversation(): Promise<ChatMessage[]> {
    // The harness opened Pi with its root conversation, so `root` finds it rather than making one.
    const pi = await this.harness.pi();
    const { sql } = this.ctx.storage;
    return recentChat(pi, await pi.root(BACKGROUND_CONTEXT), RECENT_CHAT_TURNS, {
      speakerOf: (turn) => speakerOfTurn(sql, turn),
      confirmation: (id) => confirmationShown(sql, id),
    });
  }

  /**
   * A person's tap on a confirmation the chat shows (ADR 0024): runs the call the agent made, as the
   * Caller who tapped, if it is still pending and what it describes is unchanged. Refuses one already
   * run or unknown (`not_found`), and one whose state has changed (`expired`). Every screen is told,
   * so the button shows what became of it.
   */
  @callable()
  async confirm(id: unknown): Promise<ToolResult<unknown>> {
    const caller = this.callerOf(getCurrentAgent().connection);
    const { sql } = this.ctx.storage;
    const taken = this.ctx.storage.transactionSync(() => takeConfirmation(sql, id));
    if (!taken.ok) {
      if (taken.error.code === "expired") this.notify("chat", this.bumpRevision());
      return taken;
    }
    // Claimed, so a second tap finds nothing, however long the call takes. Nothing else runs between
    // the check and the call: no I/O is awaited before the call's own transaction.
    const result = await this.invokeTool(taken.value.name, taken.value.input, caller, "client");
    if (result.ok) this.notify("chat", this.bumpRevision());
    else releaseConfirmation(sql, id as number);
    return result;
  }

  /**
   * A tool call, as `caller`; the agent's calls come here too. One from the agent that needs a
   * person's tap is held instead of run (ADR 0024).
   */
  private async invokeTool(
    name: string,
    input: unknown,
    caller: Caller | null,
    calledBy: "client",
    queued?: number,
  ): Promise<ToolResult<unknown>>;
  private async invokeTool(
    name: string,
    input: unknown,
    caller: Caller | null,
    calledBy: "agent",
  ): Promise<AgentCallResult>;
  private async invokeTool(
    name: string,
    input: unknown,
    caller: Caller | null,
    calledBy: "agent" | "client",
    queued?: number,
  ): Promise<AgentCallResult> {
    // One span per tool, named but without its input: inputs are Household data.
    const spanName = `tool ${isToolName(name) ? name : "unknown"}`;
    return this.traced<AgentCallResult>(spanName, "mise.tool", (span) => {
      // Whether the agent or a client (a screen, or RPC from inside the deployment) made it.
      span.setAttribute("mise.called_by", calledBy);
      if (queued !== undefined) span.setAttribute("mise.queued_ms", queued);
      if (calledBy === "agent" && isToolName(name)) {
        const parsed = parseToolInput(name, input);
        if (!parsed.ok) return parsed;
        const held = this.ctx.storage.transactionSync(() =>
          holdIfGuarded(this.ctx.storage.sql, name, input, parsed.value),
        );
        if (!held.ok) return held;
        if (held.value) return { held: held.value };
      }
      return this.runTool(name, input, caller);
    });
  }

  private async runTool(name: string, input: unknown, caller: Caller | null): Promise<ToolResult<unknown>> {
    const parsed = parseToolInput(name, input);
    if (!parsed.ok) return parsed;
    if (name === "run_paprika_import") {
      return this.runPaprikaImport(parsed.value as ParsedToolInput<"run_paprika_import">);
    }
    if (name === "request_suggestions") {
      return this.requestSuggestions(parsed.value as ParsedToolInput<"request_suggestions">);
    }
    if (name === "import_text") return this.importText(parsed.value as ParsedToolInput<"import_text">);
    if (name === "import_url") return this.importUrl(parsed.value as ParsedToolInput<"import_url">);
    if (name === "import_screenshots") {
      return this.importScreenshots(parsed.value as ParsedToolInput<"import_screenshots">);
    }
    if (name === "sync_drive_folder") return this.syncDriveFolder();
    if (name === "get_push_key") return this.pushKey();
    const toolName = name as Exclude<ToolName, HouseholdToolName>;
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
      // The Household's timezone decides when the export and the morning run.
      if (topic === "household") await this.scheduleDailyRuns();
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
      let photoKey: string | null | undefined = null;
      if (photoError || isUnchanged(sql, "paprika", recipe)) photoKey = undefined;
      else if (photo) photoKey = await this.storeImportedPhoto(photo, stored);
      prepared.push({ recipe, photoKey, draft: false });
    }

    const outcome = this.ctx.storage.transactionSync(() => {
      const imported = runImport(sql, "paprika", startedAt, prepared, errors);
      return { ...imported, newTexts: newTextsIn(sql, imported.written), revision: this.bumpRevision() };
    });
    this.notify("recipes", outcome.revision);
    // Asking the model takes a while, so the import answers first (ADR 0023).
    if (outcome.newTexts.length > 0) await this.schedule(0, "suggestAfterImport", { texts: outcome.newTexts });
    // Photos the updated Recipes replaced, and new ones a Recipe flagged for a merge did not take.
    for (const key of [...outcome.replacedPhotos, ...stored]) await this.deletePhoto(key);
    await this.env.BUCKET.delete(uploadKey);
    return { ok: true, value: outcome.run };
  }

  /** Has the model read pasted text into a Draft, or into a link-only Draft; see `importReading`. */
  private async importText(input: ParsedToolInput<"import_text">): Promise<ToolResult<ToolOutput<"import_text">>> {
    return this.importReading("text", input.draft, {
      read: (llm) => llm.readRecipe({ text: input.text }),
      imported: (reading) => importedFromText(input.text, reading),
      noRecipe: "The text holds no recipe",
    });
  }

  /**
   * Has the model read uploaded screenshots together into a Draft, or into a link-only Draft (see
   * `importReading`); the uploads are deleted, whatever came of them.
   */
  private async importScreenshots(
    input: ParsedToolInput<"import_screenshots">,
  ): Promise<ToolResult<ToolOutput<"import_screenshots">>> {
    try {
      const screenshots: RecipeImage[] = [];
      for (const [position, upload] of input.uploads.entries()) {
        const object = await this.env.BUCKET.get(screenshotUploadKey(upload));
        if (!object) {
          return { ok: false, error: { code: "not_found", message: `No uploaded screenshot with id ${upload}` } };
        }
        const bytes = new Uint8Array(await object.arrayBuffer());
        const type = imageType(bytes);
        if (!isScreenshotType(type)) {
          const message = `Screenshot ${position + 1} is not a JPEG, PNG, WebP or GIF image`;
          return { ok: false, error: { code: "invalid_input", message } };
        }
        screenshots.push({ bytes, type });
      }
      if (screenshots.reduce((total, { bytes }) => total + bytes.byteLength, 0) > MAX_SCREENSHOTS_BYTES) {
        const message = `The screenshots are larger than ${MAX_SCREENSHOTS_BYTES / 1024 / 1024} MB together`;
        return { ok: false, error: { code: "invalid_input", message } };
      }
      const digests = await Promise.all(screenshots.map(({ bytes }) => sha256(bytes)));
      return await this.importReading("screenshot", input.draft, {
        read: (llm) => llm.readRecipe({ images: screenshots }),
        imported: (reading) => importedFromScreenshots(digests, reading),
        noRecipe: "The screenshots hold no recipe",
      });
    } finally {
      await this.env.BUCKET.delete(input.uploads.map(screenshotUploadKey));
    }
  }

  /**
   * Has the model read a source, then imports what it read as a Draft, in one transaction, as a
   * Paprika import is; or, given `draft`, fills that link-only Draft with it. A source with no recipe
   * is logged, creating nothing. Like an import, it asks for Suggestions for the new Unresolved texts
   * once it has answered.
   */
  private async importReading(
    source: Extract<ImportSource, "text" | "screenshot">,
    draft: RecipeId | undefined,
    reader: {
      read: (llm: Llm) => Promise<RecipeReading>;
      imported: (reading: Extract<RecipeReading, { isRecipe: true }>) => ImportedRecipe;
      noRecipe: string;
    },
  ): Promise<ToolResult<ToolOutput<"import_text">>> {
    const startedAt = new Date().toISOString();
    const { sql } = this.ctx.storage;
    const linkOnly = (id: number) => {
      const recipe = readRecipe(sql, id);
      return recipe && isLinkOnly(recipe);
    };
    const noDraft = {
      ok: false,
      error: { code: "not_found", message: `No link-only Draft with id ${draft}` },
    } as const;
    if (draft !== undefined && !linkOnly(draft)) return noDraft;
    let reading: RecipeReading;
    try {
      reading = await reader.read(openLlm(this.env));
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      Sentry.captureException(error);
      return { ok: false, error: { code: "model_failed", message: error.message } };
    }
    const recipe = reading.isRecipe ? reader.imported(reading) : null;
    const outcome = this.ctx.storage.transactionSync(() => {
      // The Draft may have been filled or discarded while the model read.
      if (recipe && draft !== undefined && !linkOnly(draft)) return null;
      const imported = !recipe
        ? runImport(sql, source, startedAt, [], [{ entry: null, message: reader.noRecipe }])
        : draft !== undefined
          ? fillDraft(sql, source, draft, recipe, startedAt)
          : runImport(sql, source, startedAt, [{ recipe, photoKey: null, draft: true }], []);
      const made =
        recipe && (draft !== undefined ? readRecipe(sql, draft) : readRecipeFrom(sql, source, recipe.externalId));
      return {
        ...imported,
        made: made && { id: made.id, title: made.title },
        newTexts: newTextsIn(sql, imported.written),
        revision: this.bumpRevision(),
      };
    });
    if (!outcome) return noDraft;
    this.notify("recipes", outcome.revision);
    if (outcome.newTexts.length > 0) await this.schedule(0, "suggestAfterImport", { texts: outcome.newTexts });
    return { ok: true, value: { run: outcome.run, recipe: outcome.made ?? null } };
  }

  /**
   * Fetches a link and imports what it read (see `readLink`) in one transaction, its photo stored
   * first as a Paprika import's are. Like one, it asks for Suggestions for the new Unresolved texts
   * once it has answered.
   */
  private async importUrl(input: ParsedToolInput<"import_url">): Promise<ToolResult<ToolOutput<"import_url">>> {
    const startedAt = new Date().toISOString();
    const { sql } = this.ctx.storage;
    const link = await readLink(sql, input.url, openLlm(this.env));
    const errors = [...link.errors];
    const stored: string[] = [];
    let photoKey: string | null | undefined = null;
    // A skipped Recipe's photo is not fetched again.
    if (isUnchanged(sql, link.source, link.recipe)) photoKey = undefined;
    else if (link.image) {
      const photo = await fetchPhoto(link.image);
      if ("error" in photo) {
        errors.push({ entry: link.image, message: photo.error });
        photoKey = undefined;
      } else photoKey = await this.storeImportedPhoto(photo, stored);
    }

    const outcome = this.ctx.storage.transactionSync(() => {
      const prepared = [{ recipe: link.recipe, photoKey, draft: link.draft }];
      const imported = runImport(sql, link.source, startedAt, prepared, errors);
      return {
        ...imported,
        made: readRecipeFrom(sql, link.source, link.recipe.externalId) as Recipe,
        newTexts: newTextsIn(sql, imported.written),
        revision: this.bumpRevision(),
      };
    });
    this.notify("recipes", outcome.revision);
    if (outcome.newTexts.length > 0) await this.schedule(0, "suggestAfterImport", { texts: outcome.newTexts });
    for (const key of [...outcome.replacedPhotos, ...stored]) await this.deletePhoto(key);
    const { id, title, draft } = outcome.made;
    return { ok: true, value: { run: outcome.run, recipe: { id, title, draft, linkOnly: isLinkOnly(outcome.made) } } };
  }

  /**
   * Schedules a sync of the Drive folder and answers at once, as reading a full folder takes minutes,
   * longer than a caller waits for an answer. The run is logged, and announced, when it finishes.
   */
  private async syncDriveFolder(): Promise<ToolResult<DriveSyncStarted>> {
    if (!openDrive(this.env)) {
      return { ok: false, error: { code: "not_configured", message: "No Drive folder is set up for Mise" } };
    }
    if (this.driveSyncAsked || this.driveSync) return { ok: true, value: { alreadyRunning: true } };
    this.driveSyncAsked = true;
    await this.schedule(0, "askedDriveSync");
    return { ok: true, value: { alreadyRunning: false } };
  }

  /** The VAPID public key devices subscribe with; `not_configured` without a usable key. */
  private async pushKey(): Promise<ToolResult<PushKey>> {
    const push = openPush(this.env);
    if (!push) return { ok: false, error: { code: "not_configured", message: "No push key is set up for Mise" } };
    try {
      return { ok: true, value: { publicKey: await push.publicKey() } };
    } catch (error) {
      if (!(error instanceof PushError)) throw error;
      Sentry.captureException(error);
      return { ok: false, error: { code: "not_configured", message: error.message } };
    }
  }

  /** Runs the sync "Sync Drive now" scheduled. Run by the scheduler. */
  async askedDriveSync(): Promise<void> {
    await this.scheduledRun("askedDriveSync", async () => {
      try {
        await this.syncDrive();
      } catch (error) {
        // The scheduler swallows callback errors, so report them here.
        Sentry.captureException(error);
        throw error;
      } finally {
        this.driveSyncAsked = false;
      }
    });
  }

  /**
   * A run the scheduler started, traced under its name: the alarm's own span says only that an
   * alarm ran, not which callback or what it did.
   */
  private scheduledRun(name: ScheduledRun, run: () => Promise<void>): Promise<void> {
    return this.traced(`scheduled ${name}`, "mise.scheduled", run);
  }

  /** Syncs the Drive folder (see `readDriveFolder`), or joins the sync already running. */
  private async syncDrive(): Promise<void> {
    const drive = openDrive(this.env);
    if (!drive) return;
    this.driveSync ??= this.readDriveFolder(drive).finally(() => {
      this.driveSync = null;
    });
    await this.driveSync;
  }

  /**
   * Has the model read each Doc in the Drive folder that changed since it was last read, and imports
   * what it read as Drafts in one transaction, their photos stored first, as a Paprika import does. A
   * Doc that holds no recipe is logged with its link and recorded as read, so it is skipped until it
   * changes. A Doc that Drive or the model failed on is logged and not recorded, so the next sync
   * reads it again. Drive's own failure is logged as the run's error.
   */
  private async readDriveFolder(drive: Drive): Promise<ImportRun> {
    const startedAt = new Date().toISOString();
    const { sql } = this.ctx.storage;
    const errors: ImportError[] = [];
    const prepared: PreparedRecipe[] = [];
    const stored: string[] = [];
    const docsRead: DriveDoc[] = [];
    let skipped = 0;

    let docs: DriveDoc[] = [];
    try {
      docs = await drive.listDocs();
    } catch (error) {
      if (!(error instanceof DriveError)) throw error;
      errors.push({ entry: null, message: error.message });
    }
    const changed = docs.filter((doc) => driveRevision(sql, doc.id) !== doc.modifiedTime);
    skipped += docs.length - changed.length;
    const llm = openLlm(this.env);
    for (const doc of changed.slice(0, MAX_DOCS_PER_SYNC)) {
      const entry = docLink(doc.id);
      try {
        const { text, hasImage } = docText(await drive.markdown(doc.id));
        const reading: RecipeReading = text
          ? await llm.readRecipe({ text: text.slice(0, MAX_PASTED_TEXT) })
          : { isRecipe: false };
        if (!reading.isRecipe) {
          errors.push({ entry, message: `${doc.name} holds no recipe` });
          docsRead.push(doc);
          skipped++;
          continue;
        }
        let photoKey: string | null | undefined = null;
        if (hasImage) {
          const photo = await firstDocImage(await drive.zippedHtml(doc.id));
          if (photo && photo.bytes.byteLength > MAX_PHOTO_BYTES) {
            errors.push({
              entry,
              message: `${doc.name}'s first image is larger than ${MAX_PHOTO_BYTES / 1024 / 1024} MB`,
            });
            photoKey = undefined;
          } else if (photo) photoKey = await this.storeImportedPhoto(photo, stored);
        }
        prepared.push({ recipe: importedFromDoc(doc, reading), photoKey, draft: true });
        docsRead.push(doc);
      } catch (error) {
        if (!(error instanceof DriveError) && !(error instanceof LlmError)) throw error;
        if (error instanceof LlmError) Sentry.captureException(error);
        errors.push({ entry, message: `${doc.name}: ${error.message}` });
      }
    }
    const waiting = changed.length - MAX_DOCS_PER_SYNC;
    if (waiting > 0) errors.push({ entry: null, message: `${waiting} more Docs are read on the next sync` });

    const outcome = this.ctx.storage.transactionSync(() => {
      const imported = runImport(sql, "gdrive", startedAt, prepared, errors, skipped);
      recordDriveDocs(sql, docsRead);
      return { ...imported, newTexts: newTextsIn(sql, imported.written), revision: this.bumpRevision() };
    });
    this.notify("recipes", outcome.revision);
    if (outcome.newTexts.length > 0) await this.schedule(0, "suggestAfterImport", { texts: outcome.newTexts });
    for (const key of [...outcome.replacedPhotos, ...stored]) await this.deletePhoto(key);
    // Nobody watches a sync, which runs at night or minutes after it was asked for.
    if (outcome.run.created + outcome.run.updated > 0) await this.pushReview();
    if (outcome.run.flagged > 0) await this.push(driveFlaggedMessage(outcome.run.flagged));
    return outcome.run;
  }

  /** Syncs the Drive folder, if there is one, then schedules tomorrow's. Run by the scheduler every night. */
  async nightlyDriveSync(): Promise<void> {
    await this.scheduledRun("nightlyDriveSync", async () => {
      try {
        if (this.household()) await this.syncDrive();
      } catch (error) {
        // The scheduler swallows callback errors, so report them here.
        Sentry.captureException(error);
        throw error;
      } finally {
        await this.scheduleDailyRuns();
      }
    });
  }

  /** Asks the model for one batch of Suggestions; see `RequestSuggestionsInput`. */
  private async requestSuggestions(
    input: ParsedToolInput<"request_suggestions">,
  ): Promise<ToolResult<ToolOutput<"request_suggestions">>> {
    try {
      const suggestions = await this.suggest(textsToSuggest(this.ctx.storage.sql, input.texts));
      return { ok: true, value: { suggestions, remaining: remainingToSuggest(this.ctx.storage.sql) } };
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      // The screen only says the model failed; the deployer finds why in Sentry.
      Sentry.captureException(error);
      return { ok: false, error: { code: "model_failed", message: error.message } };
    }
  }

  /** Asks the model about the new Unresolved texts an import brought. Run by the scheduler after it. */
  async suggestAfterImport({ texts }: { texts: string[] }): Promise<void> {
    await this.scheduledRun("suggestAfterImport", async () => {
      try {
        // They come minutes after the import answered, so the review screen may no longer be open.
        if ((await this.suggest(texts)).length > 0) await this.pushReview();
      } catch (error) {
        // The scheduler swallows callback errors, so report them here. The texts can be asked about again.
        Sentry.captureException(error);
      }
    });
  }

  /** Asks the model about `texts` in batches, storing each batch as it comes. Returns the Suggestions made. */
  private async suggest(texts: string[]): Promise<Suggestion[]> {
    const { sql } = this.ctx.storage;
    const made: Suggestion[] = [];
    for await (const batch of suggestItems(openLlm(this.env), texts, readCatalogue(sql))) {
      const outcome = this.ctx.storage.transactionSync(() => ({
        stored: storeSuggestions(sql, batch.names, batch.answers, new Date().toISOString()),
        revision: this.bumpRevision(),
      }));
      this.notify("recipes", outcome.revision);
      made.push(...outcome.stored);
    }
    return made;
  }

  /** Stores an imported photo under its SHA-256 unless already there; returns its key. */
  private async storeImportedPhoto(photo: ImportedPhoto, stored: string[]): Promise<string> {
    const key = `${PHOTO_PREFIX}sha256-${await sha256(photo.bytes)}`;
    if (!(await this.env.BUCKET.head(key))) {
      await this.env.BUCKET.put(key, photo.bytes, { httpMetadata: { contentType: photo.type } });
      stored.push(key);
    }
    return key;
  }

  /**
   * The morning's notifications, then tomorrow's morning is scheduled. Run by the scheduler at 08:00
   * Household time. Two days before a Week starts (`proposalWeekOn`), Mise proposes it if nobody has
   * started it, and says so; and asks for a Check-in if Staples are due. Every morning, tomorrow's
   * dinner's Prep-ahead note.
   */
  async morningPushes(): Promise<void> {
    await this.scheduledRun("morningPushes", async () => {
      try {
        const household = this.household();
        if (!household) return;
        const { sql } = this.ctx.storage;
        const today = localDate(new Date(), household.timezone);
        const week = proposalWeekOn(today, household);
        if (week) {
          const proposed = this.proposeIfUnstarted(week);
          const message = proposed && proposedMessage(proposed, household.locale);
          if (message) await this.push(message);
          const due = handlers.list_due_staples(sql, {}, { caller: null });
          if (due.ok && due.value.due > 0) await this.push(checkInMessage(due.value.due));
        }
        const tomorrow = addDays(today, 1);
        const prepAhead = readPrepAhead(sql);
        for (const slot of readSlots(sql, tomorrow, tomorrow)) {
          const note = prepAheadDue(slot, prepAhead);
          if (note && slot.recipe) await this.push(prepAheadMessage(slot.recipe, note));
        }
      } catch (error) {
        // The scheduler swallows callback errors, so report them here.
        Sentry.captureException(error);
        throw error;
      } finally {
        await this.scheduleDailyRuns();
      }
    });
  }

  /**
   * Proposes the Week starting on `start` unless any of its dinners is planned, by hand or by an
   * earlier Proposal: a Week someone started is never proposed again. Returns the Week proposed.
   */
  private proposeIfUnstarted(start: LocalDate): Week | null {
    const { sql } = this.ctx.storage;
    const context: ToolContext = { caller: null };
    // The check and the Proposal in one transaction, so nothing planned in between is rolled over.
    const outcome = this.ctx.storage.transactionSync(() => {
      const week = handlers.get_week(sql, { date: start }, context);
      if (!week.ok || isStarted(week.value)) return null;
      const proposed = handlers.propose_week(sql, ProposeWeekInput.parse({ date: start }), context);
      return proposed.ok ? { week: proposed.value.week, revision: this.bumpRevision() } : null;
    });
    if (!outcome) return null;
    this.notify("plan", outcome.revision);
    return outcome.week;
  }

  /**
   * Sends `message` to every device that chose its kind. A device its push service no longer knows
   * is forgotten; one it refuses is reported and kept, and the others are still sent it.
   */
  private async push(message: PushMessage): Promise<void> {
    const push = openPush(this.env);
    if (!push) return;
    const { sql } = this.ctx.storage;
    for (const subscription of subscriptionsFor(sql, message.kind)) {
      try {
        if ((await push.send(subscription, message)) === "gone") removePushSubscription(sql, subscription.endpoint);
      } catch (error) {
        if (!(error instanceof PushError)) throw error;
        Sentry.captureException(error);
      }
    }
  }

  /** Tells the devices that chose it what waits on the review screen now, if anything does. */
  private async pushReview(): Promise<void> {
    const { sql } = this.ctx.storage;
    const drafts = handlers.list_drafts(sql, {}, { caller: null });
    const suggestions = handlers.list_suggestions(sql, {}, { caller: null });
    const message = reviewMessage({
      drafts: drafts.ok ? drafts.value.length : 0,
      suggestions: suggestions.ok ? suggestions.value.length : 0,
    });
    if (message) await this.push(message);
  }

  /**
   * The conversation from the latest `turns` Member turns on, for `bun run transcript --deployed`.
   * Called by the Worker over RPC for `AGENT_LOG_PATH`, which only the agent log's service token
   * reaches; never callable over the WebSocket.
   */
  async agentLog(turns: number): Promise<AgentLog> {
    return agentLog(this.ctx.storage.sql, turns);
  }

  /**
   * The Calendar Feed for `token`, or null if it is not the current one. Called by the Worker over
   * RPC for `/cal/<token>.ics`, which bypasses Access (ADR 0019); never callable over the WebSocket.
   */
  async calendarFeed(token: string, origin: string): Promise<string | null> {
    this.tagInstance();
    return readCalendarFeed(this.ctx.storage.sql, token, origin, new Date());
  }

  /**
   * Today's Day Sheet for the Kitchen Display holding `token`. Called by the Worker over RPC for
   * `DAY_SHEET_PATH`, which bypasses Access; never callable over the WebSocket.
   */
  async daySheet(token: string): Promise<DaySheetAnswer> {
    this.tagInstance();
    return readDaySheet(this.ctx.storage.sql, token, new Date());
  }

  /**
   * Writes tonight's Backup to R2, prunes old ones, then schedules tomorrow's. Run by the scheduler
   * at 03:00 Household time.
   */
  async nightlyExport(): Promise<void> {
    await this.scheduledRun("nightlyExport", async () => {
      try {
        const household = this.household();
        if (!household) return;
        await this.env.BUCKET.put(exportKey(localDate(new Date(), household.timezone)), await this.exportFile(), {
          httpMetadata: { contentType: "application/json" },
        });
        await this.pruneBackups();
      } catch (error) {
        // The scheduler swallows callback errors, so report them here.
        Sentry.captureException(error);
        throw error;
      } finally {
        // A failed night must not stop the next one.
        await this.scheduleDailyRuns();
      }
    });
  }

  /** Deletes the Backups retention no longer keeps (ADR 0006). A failure leaves them for the next night. */
  private async pruneBackups(): Promise<void> {
    try {
      const pruned = backupsToPrune(await this.listKeys(BACKUP_PREFIX));
      for (let i = 0; i < pruned.length; i += R2_DELETE_LIMIT) {
        await this.env.BUCKET.delete(pruned.slice(i, i + R2_DELETE_LIMIT));
      }
    } catch (error) {
      // Tonight's Backup is written; only report this.
      Sentry.captureException(error);
    }
  }

  /**
   * Backup over HTTP: `GET …/export` downloads the export, `POST …/restore` loads one into an empty
   * household. Recipe photos, which are too big for a tool call (ADR 0010): `GET`, `PUT` (the image
   * as the body) and `DELETE …/recipes/<id>/photo`. A Paprika export, for `run_paprika_import` to
   * import (ADR 0011): `PUT …/imports/paprika`. A screenshot, for `import_screenshots` to read:
   * `PUT …/imports/screenshots`, one per request.
   */
  override async onRequest(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    const photo = /\/recipes\/(\d+)\/photo$/.exec(pathname);
    if (photo) return this.photo(request, Number(photo[1]));
    if (pathname.endsWith("/imports/paprika")) return this.uploadExport(request);
    if (pathname.endsWith("/imports/screenshots")) return this.uploadScreenshot(request);
    const action = pathname.split("/").at(-1);
    if (request.method === "GET" && action === "export") {
      return new Response(await this.exportFile(), { headers: { "Content-Type": "application/json" } });
    }
    if (request.method === "POST" && action === "restore") return this.restore(request);
    return new Response("Not found", { status: 404 });
  }

  /** The export as a file: deterministic, so the same data always gives the same bytes. */
  private async exportFile(): Promise<string> {
    return `${JSON.stringify(exportHousehold(this.ctx.storage.sql, await this.listKeys(PHOTO_PREFIX)), null, 2)}\n`;
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
    await this.scheduleDailyRuns();
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

  /**
   * Keeps an uploaded screenshot in R2 under a new id, which `import_screenshots` is then given. An
   * image type is not one a form can send, so another site needs a CORS preflight, as for a photo.
   */
  private async uploadScreenshot(request: Request): Promise<Response> {
    if (request.method !== "PUT") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "PUT" } });
    }
    const type = request.headers.get("Content-Type")?.split(";")[0]?.trim() ?? "";
    if (!isScreenshotType(type)) {
      return new Response("Send a JPEG, PNG, WebP or GIF image", { status: 415 });
    }
    const image = await request.arrayBuffer();
    if (image.byteLength > MAX_SCREENSHOT_BYTES) {
      return new Response(`The screenshot is larger than ${MAX_SCREENSHOT_BYTES / 1024 / 1024} MB`, { status: 413 });
    }
    const upload = crypto.randomUUID();
    await this.env.BUCKET.put(screenshotUploadKey(upload), image, { httpMetadata: { contentType: type } });
    return Response.json({ ok: true, upload });
  }

  private async photo(request: Request, recipeId: number): Promise<Response> {
    const { sql } = this.ctx.storage;
    if (request.method === "GET") {
      const key = photoKeyOf(sql, recipeId);
      // R2 leaves out the body when `If-None-Match` names the object's ETag, so a 304 costs no read.
      const ifNoneMatch = request.headers.get("If-None-Match");
      const object = key
        ? await this.env.BUCKET.get(key, ifNoneMatch ? { onlyIf: new Headers({ "If-None-Match": ifNoneMatch }) } : {})
        : null;
      if (!object) return new Response("Not found", { status: 404 });
      // A new photo gets a new key, so a URL naming the current key never names another photo
      // (ADR 0010). Any other URL is an old one, or names no key: it gets the current photo, revalidated.
      const namesCurrentKey = new URL(request.url).searchParams.get("v") === key;
      const headers = {
        "Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "Cache-Control": namesCurrentKey ? "private, max-age=31536000, immutable" : "private, no-cache",
        ETag: object.httpEtag,
      };
      if (!("body" in object)) return new Response(null, { status: 304, headers });
      return new Response(object.body, { headers });
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
   * Keeps the nightly export at 03:00, the Drive sync at 04:00 and the morning's notifications at
   * 08:00, in the Household's timezone.
   */
  private async scheduleDailyRuns(): Promise<void> {
    await this.scheduleDaily("nightlyExport", NIGHTLY_EXPORT_TIME);
    await this.scheduleDaily("nightlyDriveSync", DRIVE_SYNC_TIME);
    await this.scheduleDaily("morningPushes", MORNING_PUSH_TIME);
  }

  /**
   * Keeps exactly one upcoming run of `callback`, at the next `time` in the Household's timezone.
   * Only future runs are reconciled, so the run in progress is left for the scheduler to complete.
   */
  private async scheduleDaily(callback: DailyRun, time: string): Promise<void> {
    const household = this.household();
    const now = new Date();
    const upcoming = (await this.listSchedules()).filter(
      (schedule) => schedule.callback === callback && schedule.time * 1000 > now.getTime(),
    );
    const next = household && nextOccurrence(now, time, household.timezone);
    if (next && upcoming.length === 1 && upcoming[0]?.time === next.getTime() / 1000) return;

    for (const schedule of upcoming) await this.cancelSchedule(schedule.id);
    if (next) await this.schedule(next, callback);
  }

  /** The caller over a WebSocket; RPC from inside the deployment (tests, scheduled jobs) has none. */
  /** `who`, with the Member they sign in as, if any. */
  private resolvedCaller(who: Caller | null): ResolvedCaller | null {
    const caller = handlers.get_caller(this.ctx.storage.sql, {}, { caller: who });
    return caller.ok ? caller.value : null;
  }

  private callerOf(connection: Connection | undefined): Caller | null {
    return (connection?.state as ConnectionState | null | undefined)?.caller ?? null;
  }

  private household(): HouseholdData | null {
    const result = handlers.get_household(this.ctx.storage.sql, {}, { caller: null });
    return result.ok ? result.value : null;
  }

  /** Every R2 key under a prefix, across as many list pages as it takes. */
  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.env.BUCKET.list({ prefix, cursor });
      keys.push(...page.objects.map((object) => object.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  private notify(topic: ChangeTopic, revision: number): void {
    this.broadcast(JSON.stringify({ type: "mise:change", topic, revision } satisfies ChangeNotice));
  }

  /** The revision as it stands, for a notice of a change that isn't to the Household's data. */
  private revision(): number {
    return this.ctx.storage.sql.exec<{ value: number }>("SELECT value FROM revision WHERE id = 1").one().value;
  }

  private bumpRevision(): number {
    return this.ctx.storage.sql
      .exec<{ value: number }>("UPDATE revision SET value = value + 1 WHERE id = 1 RETURNING value")
      .one().value;
  }
}

/** The SHA-256 of `bytes`, in hex. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
