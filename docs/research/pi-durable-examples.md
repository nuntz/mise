# Pi Durable: the upstream examples against Mise's agent

How the official `@earendil-works/pi-durable` examples set up and use the Harness, and where Mise's agent (SPEC §2, §4.7; ADR 0024) does something different. Researched 2026-10-24.

## Decisions (2026-10-24)

- **Compaction:** the agent's model gets its own thresholds, computed from its window: background from about 50k tokens, blocking at about 80k, keeping 20k as said. `reserveTokens` is stretched to do it (`modelOverrides`), rather than giving pi a model copy with a smaller window, which would also cap every answer's `max_tokens`.
- **Model of an existing conversation:** on start, the household puts its conversation on `AGENT_MODEL` when it differs.
- **onReport and wake errors:** reported to Sentry without content. A parked task is retried by hand, with no button in the app.
- **Tool order:** `toolExecution: "sequential"` for the whole harness.
- **Small fixes:** read-only tools are `replay: "safe"`, a turn uses `submit` + `wait`, and `followUpMode: "one-at-a-time"` is set explicitly.
- **Kept on purpose:** `afterFailedRun: "withdraw"`, for every speaker's queued turn.
- **Not now:** splitting the preamble, an `operationId` per turn, `progress` intervals, a stream timeout, a `beforeCompact` prompt, reading `usage()`.
- **Open questions settled since:** with `thinkingLevel: "off"`, Haiku 5.5 is sent `thinking: { type: "disabled" }`. Compaction spans carry no content, and their error text is already replaced by `internal_error`.

## Sources and abbreviations

- **Upstream `main`**: `earendil-works/pi` at `38ff99177fba21e9c57a670f4e95adcf407c99c7`. Links: `M/…` = `https://github.com/earendil-works/pi/blob/38ff99177fba21e9c57a670f4e95adcf407c99c7/packages/durable/…`.
- **Upstream `v1.4.0`**: tag `v1.4.0` = `4a080252f06caf63a525d7873c5d94d3c23887e0` ("Release v1.4.0"). Links: `T/…` = `https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/…`.
- **Installed copies** (every recommendation below was checked against these):
  - `PD/…` = `node_modules/.bun/@earendil-works+pi-durable@1.4.0+147a41c250e9f430/node_modules/@earendil-works/pi-durable/dist/…`. Its `package.json` says `"version": "1.4.0"`. `apps/worker/node_modules/@earendil-works/pi-durable` resolves to it.
  - `AI/…` = `node_modules/.bun/@earendil-works+pi-ai@1.4.0+147a41c250e9f430/node_modules/@earendil-works/pi-ai/dist/…`.
  - `AG` = `node_modules/.bun/agents@0.30.1+2d099d35f6b34cd6/node_modules/agents/dist/harness/pi/index.js`, Cloudflare's `PiHarness`. Mise imports it from `agents/harness/pi` (`apps/worker/src/household.ts:60`). It resolves the same pi-durable 1.4.0 (`node_modules/.bun/agents@0.30.1+…/node_modules/@earendil-works/pi-durable` → the 1.4.0 copy).
- **Mise paths** are relative to the repo root.
- **Patches**: `patches/` holds only `@sentry%2Fcloudflare@11.4.0.patch`. No pi package is patched.

### v1.4.0 compared with `main`

`main` is 62 commits past `v1.4.0` (`git log v1.4.0..main`). `packages/durable/package.json` on `main` still says `1.4.0`, and its CHANGELOG lists that work under `[Unreleased]` (`M/CHANGELOG.md` L3–L30). The examples are the same at both refs apart from four things (`git diff -M v1.4.0 main -- packages/durable/test/examples`):

- `04-chord-state.ts` was removed and the later files renumbered down by one, in `b9fb2b85 docs(durable): renumber examples`. So `v1.4.0`'s `25-compaction.ts` is `main`'s `24-compaction.ts`, `14-chat.ts` is `13-chat.ts`, and so on.
- The watch examples (`05-watches`→`04-watches`, `21-late-join`→`20-late-join`, `24-child-tasks`→`23-child-tasks`) moved from `viewState()`/`taskGraph()` to `watch()`/`watchTaskGraph()`. Neither `main` change matters to Mise, which uses no watches.
- The compaction, chat, inbox, subagent, system-prompt and configuration examples are unchanged apart from their file names and run lines.
- The compaction defaults are the same on `main` (`M/src/harness/agent.ts` diff against the tag: only `persistWithinMs` was added to the progress policy).

**Nothing recommended below needs an upgrade.** The only `main` features worth knowing about are unreleased: `HarnessOptions.readOnly`, deferred commits and `progress.persistWithinMs` (`M/CHANGELOG.md` L5–L16). Each is flagged where it comes up.

---

## 1. Summary (most important gaps first)

1. **Compaction will in practice never run in production.** Haiku 5.5 is listed with `contextWindow: 1000000` in pi-ai 1.4.0's catalog (`AI/providers/data/anthropic.json`, key `chat:claude-haiku-5-5`). Mise passes no `settings.compaction` (`apps/worker/src/household.ts:141`), so the 1.4.0 defaults apply (`PD/harness/agent.js:10-15`). Under them the next request blocks for a compaction only above 1,000,000 − 16,384 = 983,616 tokens, and a background compaction starts only above 983,616 − 32,768 = 950,848 tokens (`PD/harness/generation.js:236-246`).
   - Upstream gives two ways to fit the thresholds to a window: example 24 sets explicit `compaction` settings, and the README recommends `modelOverrides` because "the fixed token counts rarely suit a 32k and a 1M context window alike" (`T/README.md` L565–L582).
   - Mise's own long-conversation test only compacts because it runs on a faux model with a 60k window (`apps/worker/test/agent.test.ts:456-457`).
   - The same catalog entry puts Haiku 5.5 input above 100,000 tokens at a higher tier: `inputTokensAbove: 100000` → input 0.5 instead of 0.1, and cacheRead 0.05 instead of 0.01. So the shared household conversation would run most of its life above that tier.
   - **Action:** add `settings.compaction.modelOverrides["anthropic/claude-haiku-5-5"]`, available in 1.4.0 (`PD/harness/types.d.ts:463-465`).
2. **Changing `AGENT_MODEL` will not move an existing household's conversation.** `PiHarness` applies `defaults` only when it first creates the root conversation (`AG` L438; `PiSessionDefaults` docs in `AG`'s `index.d.ts` L143–L154: "Applied to a session the first time it is created … Change one session's with `session.setModel`"). Upstream does the same in example 05 ("Later calls, including after a restart, return it and ignore both options", `M/test/examples/05-harness.ts` L46–L55) and changes a model with `configure()` (06, L71–L78).
   - SPEC §2 plans to "Promote the agent to Sonnet" by changing that constant (`apps/worker/src/agent.ts:31`). That would not reach a deployed household.
3. **Nothing reports pi's own failures.**
   - Mise passes `telemetry` but not `onReport` (`apps/worker/src/household.ts:134-146`). Without `onReport`, reports become only content-free `pi.durable.report` span events (`PD/harness/harness.js:292-300`; `T/README.md` L87).
   - The README asks hosts to use `onReport` for `session_failed`, `task_faulted` and `task_parked`, and to "show parked tasks and offer `harness.retryTask(id)`" (`T/README.md` L216–L218).
   - Mise also does not listen for PiHarness's `pi:wake_error` lifecycle event (`AG` L399–L401).
4. **Tool rounds run in parallel, and order can matter.**
   - `toolExecution` defaults to `"parallel"` (`PD/harness/agent.js:53`) and Mise does not set it.
   - Upstream shows `"sequential"` as the option for tools that must run in call order (`M/test/examples/06-configuration.ts` L53–L59; `25-coding-agent.ts` L43–L50).
   - Inference, not reproduced: "re-propose the week but keep Tuesday" needs `lock_slot` before `propose_week`. If the model emits both calls in one round, nothing guarantees that order. Mise's scripted tests make one call per model request (`apps/worker/test/scripted.ts:67-77`), so they would not catch it.
5. **Smaller gaps.**
   - No tool sets `replay` (default `"unsafe"`, `PD/harness/types.d.ts:244`). Read-only tools could be `"safe"`, as example 21 marks its idempotent tool (`M/test/examples/21-subagent-foreground.ts` L46–L47).
   - `harness.prompt()` re-reads the whole active context after every turn only to return `messages` (`AG` L526–L532), which `chat()` ignores (`apps/worker/src/household.ts:193-199`).
   - The date in the single `preamble` section re-sends the whole preamble every day (see §2.6).
   - Mise relies on the default `followUpMode: "one-at-a-time"` without stating it (see §2.8).

---

## 2. What the examples (and docs) do

### 2.1 Harness construction

- Pattern: build a registry and install named extensions, then `Harness.open(storage, { models, registry, settings?, env? }, context)`, then `harness.root(context, { agent: { model } })`. See `M/test/examples/05-harness.ts` L19–L55, `13-chat.ts` L12–L25 and `15-real-model.ts` L27–L39.
- "Nothing in the registry is saved; it is this process's code" (`05-harness.ts` L19–L22). Stored choices are names, and they rebind to whatever code is installed after a restart (`30-reload-and-restart.ts` L1–L2, L80–L87).
- Settings are "Harness-wide run policy, read at every use and never stored", and getters make them live (`06-configuration.ts` L50–L59; `25-coding-agent.ts` L40–L50; `T/README.md` L403–L425).
- On Cloudflare the README opens storage with `openDurableObjectSqliteStorage(ctx.storage)`. It passes `onWake` so the Harness keeps no timer for sleeps, and it arms an alarm and calls `resume()` when the alarm fires (`T/README.md` L166–L212). `PiHarness` packages this pattern:
  - It opens storage with the `pi_` prefix (`AG` L10–L17).
  - It runs a single `pi-wake` Lifecycle job (`AG` L56–L60, L319–L360).
  - It warns when the factory does not pass `onWake` (`AG` L441).
  - It reopens pi after a storage failure (`AG` L403–L426).

### 2.2 Conversation registry and ConversationId

- The root conversation "always has ID 1"; `root()` creates it once and later calls ignore its options (`05-harness.ts` L46–L55).
- Other conversations come from `harness.createConversation({ ownership, agent?, init? })` or `fork()`. Handles are stateless and compared by `id` (`07-harness-conversations.ts` L17–L40).
- Multi-conversation apps keep a name→`ConversationId` map in their own conversation-scoped document:
  - `defineDoc` with `history: "latest"` and `fork: "initial"`, filled in the creating commit (`03-owned-conversations.ts` L26–L64; `22-subagent-background.ts` L38–L55, L183–L204).
  - Or `init` writes per-conversation state when the conversation is created (`28-sandbox-per-conversation.ts` L18–L27, L57–L72).
- Per-conversation identity that tools need (a sandbox path) is read from such a document by `conversationId` (`28-sandbox-per-conversation.ts` L48–L52).

### 2.3 Tools and how parameters reach the model

- Every example tool is `defineTool({ name, description, parameters: Type.Object({...}), execute })` with a TypeBox object at the root (`05-harness.ts` L23–L28; `10-extension-state.ts` L38–L48; `20-late-join.ts` L29–L39; `26-plan-mode.ts` L39–L49; `30-reload-and-restart.ts` L24–L33).
  - Alternatives are expressed inside a property, not at the root: `action: Type.Union([...])` (`22-subagent-background.ts` L139–L144).
  - `defineTool` is an identity function (`PD/harness/define.js:6-8`).
- The Harness validates arguments against `parameters` before `execute()`. `prepareArguments` can repair common model mistakes before validation (`PD/harness/types.d.ts:238-252`).
- pi-ai's Anthropic adapter sends only the root `properties` and `required` as `input_schema` (`AI/api/anthropic-messages.js:1298-1326`: `legacyInputSchema = { type: "object", properties: schema.properties ?? {}, required: schema.required ?? [] }`). A root `oneOf`/`anyOf` is therefore lost.
- `replay`:
  - `"safe"` when a rerun after a crash finds its own earlier work, as in example 21's `scanConversations({ ownerTaskId })` and a fixed `requestId` (`21-subagent-foreground.ts` L46–L68).
  - `"unsafe"`, with a stated reason, when repeating could do harm (`22-subagent-background.ts` L145–L147).
  - The default is `"unsafe"` (`PD/harness/types.d.ts:243-244`). An interrupted unsafe call gives the model an `interrupted` error result (`T/README.md` L277).
- Errors: "Throwing from `execute()` gives the model an error result" (`T/README.md` L277). Example 21 throws on a failed subagent (L69–L71).
- UI data travels in `details`, separate from the model's `output` (`21-subagent-foreground.ts` L62–L63, L73; `PD/harness/types.d.ts:104-123`).

### 2.4 Tool hooks

Before and after each call there are `hook(ToolTask, { beforeTool, afterTool })` (`16-coding-tools.ts` L44–L62) and `wrapTool` (`09-registry-reload.ts` L34–L41; `29-tool-override.ts` L34–L51).

### 2.5 System prompt

- Sections come from the selected extensions, e.g. `section("preamble", () => "...", { tag: false })` (`13-chat.ts` L17–L23; `14-system-prompt.ts` L29–L41).
- Before each request the sections render, and "only the difference to what the model already saw is appended to the transcript as a `pi.system` entry" (`14-system-prompt.ts` L25–L28, L88–L91). The diff is per section key (`PD/harness/prompt.js:56-73`).
- Per-conversation state is shown through a section that reads a document (`10-extension-state.ts` L32–L56).
- README: "A section that returns something different every time, such as the current time, defeats that" cache (`T/README.md` L378).
- `instructions` render last for one conversation (`14-system-prompt.ts` L63–L76).

### 2.6 Turns, the inbox, and turns from several people

- One turn: `root.submit({ type: "input", content }, ctx)`, then `.wait(ctx)`, then the answer read as `AssistantEntry` from `answered.answer` (`13-chat.ts` L27–L37; `17-print.ts` L43–L52).
- While the conversation is busy, an input queues as a follow-up (the default), a steer, or a write. `whenBusy: "reject"` refuses instead, and a queued submission can be withdrawn (`19-inbox.ts` L36–L46).
- `followUpMode: "all"` places every queued follow-up in one run; the default places one per run (`19-inbox.ts` L26–L31; default `"one-at-a-time"` in `PD/harness/agent.js:55`).
- Input someone else said can carry its own entry kind while the model still sees `content`. The README example is a group chat line: `content: "ann: can you check the build?", entry: { kind: "chat.mention", data: { author: "ann", … } }` (`T/README.md` L519–L534).
- Idempotent admission uses `requestId`: "a retry after a crash cannot deliver it twice" (`03-owned-conversations.ts` L56–L61; `21-subagent-foreground.ts` L66–L68; `T/README.md` L823).

### 2.7 Compaction (example `24-compaction.ts`, `v1.4.0` name `25-compaction.ts`)

- Thresholds are set explicitly to suit the model's window. The example uses a 3,000-token window with `reserveTokens: 1000, keepRecentTokens: 400, backgroundTokens: 800`, with a getter so they can change live (`M/test/examples/24-compaction.ts` L41, L46–L54).
- Three kinds of compaction:
  - **Background**: once the context passes the background threshold, a compaction runs while the chat continues (L66–L76).
  - **Manual**: `root.compact(instructions)`; its summary waits in the inbox while an answer is being written (L78–L93).
  - **Overflow**: when the provider says the request is too long, generation compacts and retries once (L95–L100).
- Running compactions are watched through `LiveDoc.compactions` (L60–L62). `CompactionEntry.is(view.head)` tells which summary heads the context (L104–L110).
- README (`T/README.md` L550–L588):
  - Defaults are `reserveTokens: 16384`, `keepRecentTokens: 20000`, `backgroundTokens: 32768`.
  - `modelOverrides` keyed by `"provider/modelId"`, because "the fixed token counts rarely suit a 32k and a 1M context window alike".
  - A `beforeCompact` hook on `CompactionTask` can decline a compaction or supply its own summary.
  - Failures land in `docs["pi.live"].compactionFailure`.
- Spec §8.7 (`T/docs/spec.md` L4438–L4611):
  - The built-in prompt is "the coding agent's structured checkpoint format" (its text is at `PD/harness/compaction.js:14-50`, with "Preserve exact file paths, function names…").
  - Raw history stays in storage.
  - A compaction that a blocking generation waits for and that fails also fails the generation, with `model_error`.
- The threshold check uses the window of the model from `models.getModel()` (`PD/harness/generation.js:38`, `74`, `236-246`). If `contextWindow <= 0`, threshold compaction is off.

### 2.8 Resuming and replaying

- Interrupted work stays pending; `resume()` (or submit/wait) continues it.
- A task's state is saved after every phase, and `runtime.memo` guards side effects (`11-tasks.ts` L10–L14; `12-recovery.ts` L14–L16, L28–L35, L84–L89).
- A restarted process continues sleeping tasks and subagent reporters (`22-subagent-background.ts` L351–L361; `23-child-tasks.ts` L137–L143).
- Crash-loop guard: `settings.restartLimit` (default 5). After that many restarts a task is parked and stays parked until `retryTask(id)` (`T/README.md` L216; `PD/harness/agent.js:33-39`).

### 2.9 Errors and retries

- Retries: `settings.retry` (defaults: `maxRetries: 3`, `baseDelayMs: 2000`, `maxAgentDelayMs: 60000`, `PD/harness/agent.js:4-9`). Examples set `retry: { maxRetries: 5 }` (`06-configuration.ts` L57) or a live value (`25-coding-agent.ts` L47–L49).
- Retries sleep durably. An overflow is never retried, only compacted (`PD/harness/generation.js:405-428`).
- `settings.afterFailedRun` decides what happens to inputs queued behind a failed run: `keep` (default), `continue` or `withdraw` (`T/README.md` L220; `PD/harness/types.d.ts:507-513`).
- A storage error ends the Harness. Recover by reopening and resubmitting with the same `requestId` (`T/README.md` L819–L835).
- An unanswered submission carries `reason` and `detail` (`15-real-model.ts` L65–L67; `17-print.ts` L49–L51).

### 2.10 Observability

- `HarnessOptions.telemetry` emits content-free spans: `pi.durable.submit` and `pi.durable.phase`, with model requests nested under the phase (`T/README.md` L82–L88).
- `HarnessOptions.onReport(error, info)` receives `session_failed`, `task_faulted`, `task_parked`, `extension_error`, `host_error` and `listener_error` (`T/README.md` L218; `PD/harness/types.d.ts:595-601`).
- Spend: `harness.usage()` and `docs["pi.usage"]` (`T/README.md` L751–L757).
- Live progress for UIs comes from `watchEvents()`, `Conversation.watch()` and `LiveDoc` (`15-real-model.ts` L40–L56; `18-json.ts` L80–L94; `20-late-join.ts`).
- `settings.progress` sets how often partial answers are committed (`T/README.md` L416).

---

## 3. How Mise does it

### 3.1 Harness construction

- `PiHarness` builds a registry inside its factory and installs one extension, `mise`. It then calls `Harness.open(storage, { models, registry, onWake, settings: { afterFailedRun: "withdraw" }, telemetry: sentryTelemetry() }, context)` with `defaults: { model }` (`apps/worker/src/household.ts:125-149`).
- The harness is attached with `this.lifecycle.use(this.harness)` (`apps/worker/src/household.ts:155`).
- `onWake` is passed, which follows the README and `PiHarness` guidance.
- Models: `anthropicModels()` registers pi-ai's Anthropic provider with the key from the Worker secret (`apps/worker/src/llm.ts:23-32`). The agent model is `claude-haiku-5-5` (`apps/worker/src/agent.ts:31`), and tests swap the models in (`apps/worker/src/agent.ts:36-50`; `apps/worker/test/scripted.ts:84-92`).

### 3.2 Conversation and ConversationId

- One root conversation for the Household: `pi.root(BACKGROUND_CONTEXT)` (`apps/worker/src/household.ts:211-220`). The `PiHarness` session id is the default root.
- Tools find the speaker from `api.conversationId`:
  1. `callerAnswered` opens the conversation and calls `turnBeingAnswered`, which pages `conversation.entries()` newest first for the latest `mise.turn` entry (`apps/worker/src/household.ts:202-207`; `apps/worker/src/agent.ts:322-332`).
  2. The turn's speaker is looked up in the Household's own `chat_turn` table (`apps/worker/src/turns.ts:9-46`).
- Per-Caller conversations are deferred: "recording the speaker keeps that a data split" (SPEC §4.7).

### 3.3 Tools and parameters

- Each registry tool becomes a hand-built `ToolRegistration` (not `defineTool`, which is an identity function anyway). Its input schema comes from zod via `z.toJSONSchema` (`apps/worker/src/agent.ts:239-272`):
  - Item ids are overridden to a plain string (`agent.ts:242-249`).
  - `$schema` and zod's hidden `~standard` field are dropped (`agent.ts:251-252`).
  - A root `oneOf`/`anyOf` is merged into one object by `asOneObject` (`agent.ts:282-313`), because pi-ai sends only the root properties (confirmed in §2.3).
- `execute` calls the household's single entry point as the turn's speaker.
  - A call held for a tap returns text plus `details: { confirmation }` (ADR 0024).
  - A refusal throws `Error(JSON.stringify(error))`, which pi turns into an error result (`agent.ts:257-270`).
- No `replay`, `executionMode` or `prepareArguments` is set (`agent.ts:253-271`).

### 3.4 System prompt

- One section, `preamble` with `tag: false`, rendered on every request from `get_household` (`apps/worker/src/agent.ts:168-207`, `229-232`).
- It holds today's date (`agent.ts:178-184`), the Members and their Constraints, and the rules, including the ADR 0024 rule about confirmations (`agent.ts:200-205`).

### 3.5 Turns and concurrency

- `chat()` records the turn in `chat_turn` and builds the model-facing text with `presentTurn` (speaker plus screen).
- It calls `this.harness.prompt(presented, { entry: { kind: TURN_ENTRY, data } })` (`apps/worker/src/household.ts:180-200`), the same pattern as README L519–L534.
- No `operationId` is passed, so `PiHarness` mints a random UUID (`AG` L237). `whenBusy` defaults to `followUp` (`AG` L248).
- Sequential turns are tested: "two people's messages are answered one after the other" (`apps/worker/test/agent.test.ts:275-316`).

### 3.6 Compaction

- No `settings.compaction` is given (`apps/worker/src/household.ts:141`).
- The chat reads the whole history, so summarised turns stay visible (`apps/worker/src/agent.ts:340-359`).
- The test compacts only on a faux model with `contextWindow: 60_000` (`apps/worker/test/agent.test.ts:454-479`).
- The preamble tells the model that "Earlier turns may be out of date … the tool is right" (`apps/worker/src/agent.ts:195-196`). That partly guards against stale summaries.

### 3.7 Errors and retries

- `afterFailedRun: "withdraw"`, with the reason "later messages are not run against a stale question" (`apps/worker/src/household.ts:140-141`).
- An unanswered run returns `{ code: "unanswered", message: reason }` (`household.ts:196-198`), which is tested (`apps/worker/test/agent.test.ts:109-118`).
- Retry, restart limit and stream timeout use the defaults.

### 3.8 Observability

- `sentryTelemetry()` maps pi's `TelemetryContext` onto `Sentry.startSpan`. Error status keeps only `internal_error`, and links are dropped (`apps/worker/src/observability.ts:104-128`).
- Spans are scrubbed of prompt and response attributes (`observability.ts:14-15`, `72-80`). Tests: `apps/worker/test/observability.test.ts:84-146`.
- Each chat turn is wrapped in a `mise.agent` span (`apps/worker/src/household.ts:192-194`).
- No `onReport`, no `usage()`, and no listener for `pi:wake_error`.

---

## 4. Differences

| Topic | Upstream practice | Mise | Gap or deliberate? | Upgrade needed? | Suggested action |
|---|---|---|---|---|---|
| **Compaction thresholds** | Set `compaction` to suit the window; `modelOverrides` for big windows (`24-compaction.ts` L46–L54; `T/README.md` L565–L582) | Defaults on a 1M-window model, so it compacts above about 950k tokens (§1 item 1) | **Gap.** SPEC §4.7 expects "the harness compacts it"; nothing records a choice to wait until about 1M tokens | No: `modelOverrides` is in 1.4.0 (`PD/harness/types.d.ts:463-465`; CHANGELOG 1.4.0 "Added") | Set `settings.compaction.modelOverrides["anthropic/claude-haiku-5-5"]`. Thresholds are measured from `contextWindow`, so to block at about 80k set `reserveTokens: 920_000` and to start background at about 50k set `backgroundTokens: 30_000`, keeping `keepRecentTokens` around 20k. **Caveat (inference):** this repurposes `reserveTokens` ("room kept free for the answer"). The summary's `maxTokens` becomes `min(0.8 × reserveTokens, model.maxTokens)` = 128,000 (`T/docs/spec.md` §8.7 `select`). Compute the window from `models.getModel(...)` rather than hard-coding it. Add a test that asserts the override for the real model id |
| Compaction prompt | Built-in coding checkpoint prompt; `beforeCompact` can supply a summary; `compact(instructions)` for manual runs (`T/README.md` L584; `PD/harness/types.d.ts:816-834`) | Built-in prompt | Not documented either way | No | Optional: a `beforeCompact` hook (`hook(CompactionTask, …)`) for a household-shaped summary, e.g. keep who said what and drop plan details that tools re-read. Low priority while §4.7's "tools are the truth" rule stands |
| Compaction observability | `LiveDoc.compactions` / `compactionFailure`; `compaction_start` and `compaction_end` events (`T/README.md` L588) | Not read | Gap (minor) | No | Surface `compactionFailure` through `onReport`/Sentry, or in a debug view |
| **Model of an existing conversation** | Options to `root()` apply only on creation; change with `configure({ model })` (`05-harness.ts` L46–L55; `06-configuration.ts` L68–L78) or `PiHarness` `session.setModel` | `defaults: { model }` only (`household.ts:148`) | **Gap**: SPEC §2's "promote the agent to Sonnet" would not reach existing Households | No: `setModel` is in agents 0.30.1 (`AG` L570–L572); `configure` in 1.4.0 | On start, compare the root's stored model (`(await root.agent(ctx)).model`) with `AGENT_MODEL` and call `harness.session().setModel(...)` when they differ. Or document that promotion needs this step |
| Harness construction | `Harness.open` + registry + settings; on Cloudflare, `onWake` and an alarm | Same, through `PiHarness`, with `onWake` passed | Matches | No | None |
| Conversation registry / ConversationId | Root is id 1; other conversations are mapped in a conversation-scoped `defineDoc` (`history: "latest"`, `fork: "initial"`) or written by `init` (03, 22, 28) | Root only; the speaker is found by scanning entries for `mise.turn` | Deliberate: one shared conversation (SPEC §4.7). The scan is sound because follow-ups are placed one at a time | No | When per-Caller conversations come, follow example 28: `createConversation({ ownership: { kind: "ownerless" }, init })` and keep the Caller→`ConversationId` map in a Household table or a conversation doc |
| Speaker identity relies on queue mode | Default `followUpMode: "one-at-a-time"`; `"all"` places several follow-ups in one run (`19-inbox.ts` L26–L31) | Implicit default | Deliberate per SPEC ("turns from two people run one after the other"), but unstated | No | Set `followUpMode: "one-at-a-time"` explicitly, with a comment that `turnBeingAnswered` depends on it. Never submit with `whenBusy: "steer"` |
| Tool parameters | TypeBox `Type.Object` at the root; unions inside properties (22 L139–L144) | zod → JSON Schema → `asOneObject` flattening → `Type.Unsafe` | Deliberate and consistent: pi-ai drops root alternatives (`AI/api/anthropic-messages.js:1305-1317`); the household re-validates | No | None needed. `prepareArguments` (1.4.0) is a cleaner place for any argument repair, if needed |
| Tool `replay` | `"safe"` for idempotent tools; default `"unsafe"` gives an `interrupted` result (21 L46–L47; 22 L145–L147; README L277) | Unset (all unsafe) | Gap (minor). Unsafe is right for writes; read-only tools get needless `interrupted` results after an eviction | No | Mark read-only tools (`get_*`, `list_*`, `search_recipes`, `check_slot_constraints`) `replay: "safe"`. Keep writes unsafe |
| **Tool execution order** | `toolExecution: "sequential"` when calls must run in order (06 L53–L59; 25 L43–L50) | Default `"parallel"` | **Gap (inference)**: rounds with `lock_slot` + `propose_week` have no guaranteed order | No | Set `settings.toolExecution: "sequential"`, or `executionMode: "sequential"` on write tools ("one sequential call makes its whole round sequential", `PD/harness/types.d.ts:245-246`). Add a test that emits both calls in one round |
| Tool errors | Throw, giving an error result (README L277; 21 L69–L71) | Throws `JSON.stringify(error)` | Matches | No | None |
| System prompt | Sections rendered per request; per-key diffs; avoid sections that change every request (README L378) | One `preamble` section holding date, Members and rules | Mostly matches. The date changes daily, so the whole preamble is re-sent as a new `pi.system` entry once a day (per-key diff, `PD/harness/prompt.js:56-73`) | No | Optional: split into `rules` (stable), `household` (Members, Constraints) and `today` (date) sections so daily diffs stay small |
| Who said each turn | `content` shown to the model plus your own `entry` kind for display (README L519–L534) | Exactly this: `presentTurn` plus `mise.turn` entry | Matches | No | None |
| Idempotent submission | `requestId` / `operationId` so retries don't double-submit (03, 21, 22; README L823) | Random UUID per call | Low-risk gap: a turn is recorded per `chat()` call, so a retried RPC is a new turn anyway | No | Optional: pass `operationId: \`turn:${turn}\`` so a resubmit after a storage-failure reopen finds the first submission |
| Waiting for the answer | `submit` + `wait` + read `AssistantEntry` (13, 17) | `harness.prompt()`, which also reads the full active context into `messages` (`AG` L526–L532) | Gap (efficiency) | No | Use `harness.submit(...)` then `harness.wait(operationId)`. `wait` already returns `text` (`AG` L491–L512) |
| Failed run and queued turns | `afterFailedRun` `keep` (default), `continue` or `withdraw` (README L220) | `withdraw` | Deliberate (`household.ts:140`). Note: a second person's queued turn is dropped with `run_failed` when the first person's run fails | No | Consider whether another speaker's turn should be withdrawn, or only the failed speaker's; `continue` would answer it. Document in an ADR if kept |
| Retries / stream timeout | `retry` and `stream.timeoutMs` set explicitly in examples (06 L53–L58; 25 L47–L49) | Defaults | Not documented | No | Optional: set `stream.timeoutMs` well under the Durable Object/RPC budget so a stuck request fails as `model_error` rather than hanging the chat |
| Crash loops | `restartLimit`; show parked tasks; `retryTask` (README L216) | Default 5; no surfacing | Gap | No (1.4.0 "Added") | Report `task_parked` through `onReport`. `PiHarness.retry()` exists (`AG` L198–L200); expose it, or let an operator call it |
| **onReport** | Hosts handle `session_failed`, `task_faulted`, `task_parked` (README L218) | Not passed | **Gap** | No | Pass `onReport: (error, info) => Sentry.captureMessage(info.type, { tags: { kind: info.task?.kind } })`. Send only `info.type`, task kind and extension, never `error.message`, which may quote prompts, in line with `observability.ts:104-109` |
| Telemetry | `HarnessOptions.telemetry` from the host (README L82–L88) | `sentryTelemetry()` adapter, content scrubbed | Matches | No | None. SPEC §2 names a "Sentry Pi Durable integration"; Mise's own adapter fills that role |
| Wake errors | `PiHarness` emits `pi:wake_error` on its Lifecycle events (`AG` L399–L401) | Not listened to | Gap (minor) | No | Forward it to Sentry |
| Progress commits | `settings.progress` intervals (README L416); deferred storage on `main` only | Default 100 ms partial commits to DO SQLite, though the chat reads only final answers | Gap (cost, minor; inference) | No for `partialIntervalMs`; **yes** for `progress.persistWithinMs` (unreleased on `main`, `M/CHANGELOG.md` L10, L14) | Raise `progress.partialIntervalMs` (e.g. 1000) while nothing streams to the PWA |
| Usage | `harness.usage()` / `pi.usage` (README L751–L757) | Not read | Not needed by SPEC (spend is capped in the Anthropic console, §4.7) | No | Optional: tag the `mise.agent` span with per-turn usage |

---

## 5. Open questions

1. **Does Haiku 5.5's real window match the catalog's 1,000,000 tokens, and does its tier start at 100k?** Both figures come from pi-ai's bundled catalog (`AI/providers/data/anthropic.json`), not from Anthropic's documentation, which I did not check. The compaction recommendation holds either way, since a family chat needs nowhere near that much context. The cost argument depends on the tier.
2. **Is there a cleaner way to cap the effective window than inflating `reserveTokens`?** For example, registering a model copy with a smaller `contextWindow` in `Models`. Not established from the sources. 1.4.0's policy is defined only relative to `contextWindow` (`PD/harness/generation.js:236-246`), and no "max context tokens" setting exists at either ref.
3. **Does the model actually emit `lock_slot` and `propose_week` in one round?** Unverified. Whether parallel execution then reorders them in practice also needs a test on the real model.
4. **How do thinking levels interact with this model?** `thinkingLevel` defaults to `"off"` (`PD/harness/agent.js:226`), and Haiku 5.5's catalog entry has `forceAdaptiveThinking: true` and no `"off"` in its `thinkingLevelMap`. I did not trace what pi-ai sends for `"off"` on this model.
5. **Should a compaction summary run through Mise's scrubbing?** The summary request goes through the same models and telemetry, and I did not check whether its spans carry any content-bearing attributes the scrubber's regex misses (`apps/worker/src/observability.ts:14-15`).
6. **The README and spec links on `main` point to renumbered examples.** For example, `T/README.md`'s table names `25-compaction.ts`, which on `main` is `24-compaction.ts`. Citations above give both names where it matters. No newer tag than `v1.4.0` exists to compare against (`git tag --sort=-creatordate` → `v1.4.0` newest).
