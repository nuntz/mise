# GPT-Live-1 as a voice front end over the Mise agent

Whether OpenAI's GPT-Live-1 can be only the voice layer of Mise (SPEC §2 Voice row, §4.8, Drop 3), with every bit of reasoning and every tool call handled by the household's Pi Durable agent on Claude. Researched 2026-10-30.

## Verdict for the spike

- **Feasible, and documented.** GPT-Live-1 exists under that name (model ID `gpt-live-1`, shown as "GPT-Live 1") [M]. OpenAI built it for this split. It has a **client delegation** mode in which "your application" runs the backend, and that backend can be "any model, agent harness, or service your application runs" [G]. OpenAI's migration guide covers this exact case: keep an existing text agent and add GPT-Live as its voice [MIG §From a text agent].
- **This is not a tool call.** In client mode GPT-Live sends `session.delegation.created`. The event carries metadata only and "does **not** contain the user's utterance or task text". The application works out the request from the transcript events and its own state, then sends back plain text (at most 500 tokens), which GPT-Live paraphrases aloud [D §Keep the conversation context; D §Send the right kind of update]. The GPT-Live session has no function tools of its own: the only `tools` field in the session config is inside Responses delegation [R-create]. So an `ask_mise_agent(utterance)` tool is not the pattern. It is only possible through Responses delegation, which puts an OpenAI model in between (see §3).
- **Recommended pattern for the prototype:**
  1. The Worker creates the session with `POST /v1/live/sessions`, relaying the browser's SDP offer with the OpenAI key. Live has no ephemeral client token.
  2. The household DO attaches a **sideband** WebSocket to that session.
  3. On each delegation, the DO builds a turn from its transcript ledger and runs it through the same path as `chat` (`apps/worker/src/household.ts:234`).
  4. The DO returns the agent's answer with `session.commentary.append`.
  5. The DO also counts `session.usage.updated` seconds toward the daily cap and sends `session.close` when the cap is reached.
  6. Browser audio stays on WebRTC.
- **What the prototype must still prove:**
  - The real delegation-to-speech latency of a Haiku turn through PiHarness, and how it feels over the automatic acknowledgement. No timeout is documented.
  - Whether a turn built from transcript fragments is complete enough. The delegation can arrive before the sentence is fully transcribed.
  - How often GPT-Live answers on its own instead of delegating. It decides when to delegate, and no mode switches its own replies off.
  - That a Durable Object can hold the sideband. That means an outbound WebSocket with an `Authorization` header and no hibernation, plus reflected 24 kHz PCM audio arriving on it, at acceptable CPU and duration cost.
  - What voice confirmation looks like under ADR 0024.

## Sources

All fetched 2026-10-30. OpenAI doc pages carry no version or date, so the changelog dates are given where they exist. OpenAI pages were read as Markdown (`.md` suffix, as each page instructs).

- **[M]** Model page: https://developers.openai.com/api/docs/models/gpt-live-1
- **[CL]** API changelog: https://developers.openai.com/api/docs/changelog. Entries used: "Sep 10" (GPT-Live 1 generally available), "Oct 15" (native Decisions integration) and "Oct 16" (voices).
- **[G]** Getting started with GPT-Live: https://developers.openai.com/api/docs/guides/live
- **[D]** Delegation and tools in GPT-Live: https://developers.openai.com/api/docs/guides/live-delegation
- **[C]** Managing GPT-Live sessions: https://developers.openai.com/api/docs/guides/live-conversations
- **[P]** Prompting GPT-Live: https://developers.openai.com/api/docs/guides/live-prompting
- **[MIG]** Migrate to GPT-Live: https://developers.openai.com/api/docs/guides/live-migration
- **[VA]** Voice agents (architecture comparison): https://developers.openai.com/api/docs/guides/voice-agents
- **[W]** WebRTC, Live variant: https://developers.openai.com/api/docs/guides/voice-webrtc?api=live
- **[S]** Server-side controls (sideband), Live variant: https://developers.openai.com/api/docs/guides/voice-server-controls?api=live
- **[$]** Usage and cost, Live variant: https://developers.openai.com/api/docs/guides/voice-latency-cost?api=live
- **[DV]** Connect voice to Decisions: https://developers.openai.com/api/docs/guides/decisions-voice
- **[R-create]** API reference, Create session (`POST /live/sessions`): https://developers.openai.com/api/reference/resources/live/methods/create
- **[R-live]** API reference, Live resource (includes Sessions → Hang up): https://developers.openai.com/api/reference/resources/live
- **[R-primary]** API reference, Live primary WebSocket events: https://developers.openai.com/api/reference/resources/live/primary-websocket
- **[R-sideband]** API reference, Live sideband WebSocket: https://developers.openai.com/api/reference/resources/live/sideband-websocket
- **[SDK]** `openai/openai-node` at tag `v7.45.1` (published 2026-10-27), `src/resources/live/` (`live.ts`, `sessions.ts`, `sideband/ws.ts`). Mise has `openai@7.19.0` in `node_modules/.bun` only as a transitive dependency. The Worker does not use it.
- **[LC]** `openai/openai-live-console` at `5f64ecb3009d8274da9953c825d469ea6b6b67c3` (2026-09-12): `README.md` and `server/session.ts`. OpenAI's own sample. Its README says "End-to-end compatibility with `gpt-live-1` still needs verification; this repository is not a public-release approval."
- **[CF-voice]** Cloudflare Agents, Voice: https://developers.cloudflare.com/agents/communication-channels/voice/ (page "Last updated Oct 29, 2026")
- **[CF-ws]** Cloudflare Workers, WebSockets runtime API: https://developers.cloudflare.com/workers/runtime-apis/websockets/ (page "Last updated Oct 12, 2026")
- **[CF-DO-ws]** Cloudflare Durable Objects, Use WebSockets: https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (page last updated October 30, 2026)
- **Mise paths** are relative to the repo root.

No blog posts or third-party write-ups are relied on. A web search turned up press coverage, including turn-latency benchmark figures. Those figures are not repeated here because no OpenAI page states them.

---

## 1. What GPT-Live-1 is, connection, pricing, limits

### What it is

- "GPT-Live 1 is a full-duplex voice model for real-time conversations. It can listen and speak at the same time, and delegate reasoning and tool use to a backend agent." Model ID and only snapshot: `gpt-live-1`. Input and output are audio and text; images and video are not supported [M].
- It was generally available in the API on Sep 10 (2026) [CL].
- OpenAI positions it next to two other voice architectures [VA]:
  - the Realtime API: "Speech, reasoning, and tool use in one session";
  - a chained STT → agent → TTS pipeline.
- "GPT-Live handles conversation. It listens, speaks, and decides when to ask the backend for help." The backend "reasons, uses tools, and returns results for GPT-Live to communicate" [G].
- Its only endpoint is `v1/live/sessions`. `v1/realtime`, `v1/responses` and `v1/chat/completions` are marked "Not supported" [M]. So it is not the Realtime API under a new name, and Realtime docs and SDK helpers do not apply.

### How a browser connects

- WebRTC is "recommended for audio connections in browser, mobile, and server applications"; WebSocket and SIP are alternatives [G].
- The sequence [W §Understand the connection sequence]:
  1. The browser creates an SDP offer, with the data channel labelled `oai-events`.
  2. **Your server** posts `{ session, transport: { type: "webrtc", sdp } }` to `POST /v1/live/sessions` with the project API key.
  3. The server returns the SDP answer.
  4. The browser waits for `session.started` on the data channel. "Do not send `session.start` on the data channel."
- The response is `{ session: { id: "live_…" }, transport: { type: "webrtc", sdp } }`. The ID is opaque and used for sideband and controls [W §Read the session response; R-create §Returns].
- **No ephemeral client tokens for Live.** The WebRTC guide's Live section uses only the server relay ("Keep the key and session configuration on your trusted server") [W]. The reference index lists "Realtime Client Secrets" and no Live equivalent [R-live; reference index https://developers.openai.com/api/reference/llms.txt]. The ephemeral-key flow on the same WebRTC page belongs to the Realtime API section [W, Realtime half].
- The session config has an optional `client.data_channel` block with `allowed_client_events` and `allowed_server_events`. It holds "startup-only capabilities for an untrusted frontend attached to a unified WebRTC session. Trusted sideband connections are unaffected." When omitted, the browser may send every client event [R-create, `client`].
- SDK: `client.live.create({ session, transport })` in openai-node [W server example; SDK `live.ts`]. A Worker can just as well call the REST endpoint with `fetch`.

### Pricing

- "Voice sessions cost $0.05 per minute, billed per second. Backend model and tool usage is billed separately." Duration is not rounded up [M].
- "Active session time includes time when the user speaks, the assistant speaks, both are silent, or the backend is working." Muting the microphone does not stop billing [$ §Voice session costs].
- Each WebRTC `POST /v1/live/sessions` bills 15 seconds during initialization. That amount is credited against the running session, so a session ended within 15 seconds still costs 15 seconds [$ §WebRTC initialization charges; W].
- With client delegation, the backend (Anthropic, for Mise) costs nothing on OpenAI's bill.

### Session limits

- Rate limits are counted in **concurrent sessions**: Build tier 50, Launch 300, Grow 500. The Free tier is unsupported [M].
- The create-session description says: "Ringing is limited to 3 minutes and connected calls to 2 hours; these limits are not configurable in the request" [R-create]. The paragraph is about SIP, so whether the 2-hour limit also covers WebRTC sessions is **unverified**. `session.closed.reason` has an `expired` value: "The session reached its duration limit" [C §Usage and graceful close; R-primary].
- **No request field sets a maximum duration.** The session fields are `model`, `audio`, `client`, `delegation`, `input`, `instructions`, `store` and `triggers` [R-create].
- Context window: 128,000 tokens. Above 90% usage, GPT-Live "starts a replacement voice engine within the same session" with the original instructions plus at most 8,192 tokens of recent history and summary [C §Manage longer conversations].
- `instructions`: at most 16,384 tokens, immutable after startup. `input` (seed history) is text-only, at most 128 messages and 8,192 rendered tokens by default [R-create].
- Voice is chosen at startup. The default is `marin` [C §Configuration fields].

## 2. Tool calling and asynchronous answers

### Delegation is the tool call

- In client mode, GPT-Live itself calls no functions. When it decides to delegate, the application receives [D §Receive a client delegation]:
  ```json
  { "type": "session.delegation.created", "offset_ms": 1000,
    "delegation": { "id": "item_…", "type": "delegation", "target": "client" } }
  ```
  The schema says: "This object contains metadata, not the task text" [R-primary, `session.delegation.created`].
- The application answers with one of three events, quoted from [D §Send the right kind of update]:

  | Event | Use |
  |---|---|
  | `session.commentary.append` | "Information the model should speak aloud, paraphrasing the appended text" |
  | `session.thinking.append` | "Information for internal reasoning, not spoken on append but usable for relevant user questions" |
  | `session.instructions.append` | "Instructions for an ongoing live conversation" |

  All three take a plain string `content` of at most 500 tokens and a `delegation_id`, either the delegation's ID or `null` for general context. "You can send multiple updates with the same client delegation ID" [D].
- Acknowledgements (`session.*.appended`) mean "estimated context injection, not for speech or playback to finish" [D; C §Understand when context reaches the model].
- In the prompt, delegation is requested with the literal instruction `Generate <|SpawnThinking|>`, set out in a "Delegation policy" section with "Generate … when" and "Do not generate … when" lists [P §Recommended prompt structure; P §Delegation].

### Asynchronous answers, latency tolerance, timeouts

- Answers are asynchronous by design. "GPT-Live can keep talking with the user and explain the result when it arrives" [G]. With client delegation, "application-managed backend work can continue independently while voice is closed" [C §Close idle sessions and resume].
- **No timeout for a client delegation is documented.** The guides, the create reference and the primary-WebSocket reference were searched. The only `timeout_ms` fields belong to hosted shell tools [R-primary].
- OpenAI's latency advice for client mode [D §Reduce backend latency → Client delegation]:
  - reuse connections;
  - prepare configuration ahead of time;
  - "Stream useful results" as coherent chunks of commentary;
  - "Measure the first useful spoken answer".

  The cost guide adds that a wait is also billed voice time [$ §Reduce time spent waiting for tools].

### Filler speech while waiting

- By default GPT-Live speaks an automatic acknowledgement as soon as it delegates. For client sessions, `delegation.acknowledgement_delay_ms` defaults to 0, with a maximum of 800 [R-create, `ClientDelegation`].
- To suppress the acknowledgement, set the delay and send `session.thinking.append` with empty `content` as soon as `session.delegation.created` arrives. Caveats [D §Suppress automatic acknowledgments while tools run]:
  - the append cancels "**all pending automatic acknowledgments in the session**";
  - "the model may still speak earlier";
  - guaranteed silence needs application-controlled playback.
- The prompt can set the style while work runs, for example "Concise · brief receipt, then quiet" or "Chatty · natural progress" [P §Personality during tool calls].
- "A spoken promise such as 'I'm checking that' does not confirm that backend work has started" [P §Delegation].

### Interruption

- Full duplex: "Instructions can encourage it to yield when interrupted, but they do not provide precise control over when it stops speaking. The model may keep speaking briefly after an interruption" [P §Interruptions].
- "Stopping speech leaves backend work running. If the user changes the task, update the application's active work too" [P §Interruptions]. The same point appears in [D §Keep updates accurate and useful].
- The primary-WebSocket event list has no "delegation cancelled" or "superseded" event. Its delegation events are `session.delegation.created` and the append acknowledgements (event list read from [R-primary]). So a correction such as "Thursday, not Friday" reaches the application only as new transcript text and, possibly, a new delegation. The application decides whether to cancel, change or discard the earlier work [MIG §Route updates and corrections].
- `session.instructions.append` "can interrupt the model's current speech". It is the documented way to make the model stop and redirect [D; S §Redirect the conversation].

## 3. Is there a "no reasoning of its own" mode? Options compared

**No mode turns GPT-Live's own replies off.** Its role is to listen, speak "and decide when to ask the backend for help" [G]. The prompt template keeps a "Do not generate `<|SpawnThinking|>` when … You can answer from the conversation or a still-current result" clause [P]. Client delegation comes closest to "front end, not a second brain": GPT-Live chooses when to hand off, and what Mise's agent decides comes back as text for it to paraphrase. Whether it answers things it should have delegated has to be tested with the prompt.

| Option | How it works | For Mise | Against |
|---|---|---|---|
| **A. Client delegation** (recommended) | `delegation: { type: "client" }`, which is also the default when omitted or `null` [C §Configuration fields]. The app builds the request from `session.input_transcript.delta` / `session.output_transcript.delta` plus its own state, runs its agent, and returns commentary [D §Configure client delegation]. | The documented path for "connect an existing agent" [G; MIG]. No OpenAI model sees Mise data beyond the audio and the text returned for speech. Matches SPEC §6 ("GPT-Live-1 receive[s] only … voice audio"). The agent keeps one conversation and one tool path. | The application has to keep the transcript ledger and segment turns itself. "Transcript deltas have no item ID or event that marks a completed conversational turn" [C §Transcript deltas]. "The notification may arrive before the full sentence is transcribed" [MIG]. Transcripts "may contain mistakes" [D]. |
| **B. Responses delegation with one function `ask_mise_agent`** | `delegation.responses` with an OpenAI backend model (e.g. `gpt-6-luna`) and a function tool. The app executes the function and returns `function_call_output`, then sends `response.create` [D §Configure Responses delegation; §Return tool results and approvals]. | The arguments arrive as a structured string written by a model, not raw transcript. | A second OpenAI model reasons on every turn, billed in tokens [M "Backend Responses calls use the normal pricing"]. That is exactly the "second brain" SPEC rules out. It also adds one model hop of latency and sends Mise conversation context to OpenAI. |
| **C. Realtime API with one forwarding tool** | `gpt-realtime-2.1` over `v1/realtime`, with its own function calling [VA; W Realtime section]. | A familiar single-session model. | Not GPT-Live: it is another model, and GPT-Live does not support `v1/realtime` [M]. The voice model also does the reasoning [VA]. Not researched further. |
| **D. Chained STT → Mise agent → TTS** | Cloudflare's `agents/voice` `withVoice` runs continuous STT, `onTurn()` and sentence-chunked streaming TTS over WebSocket (beta) [CF-voice]. Providers: Workers AI Deepgram Flux / Nova-3 and Aura, plus Deepgram, ElevenLabs and Telnyx packages [CF-voice]. | No OpenAI at all. Runs in the DO. Turn boundaries come from STT, so the agent gets whole utterances. | Not full duplex. Every turn waits for the agent before any speech, unless the app adds filler. [CF-voice] does not mention GPT-Live or OpenAI Realtime. |

Cloudflare has **no GPT-Live integration** in its Agents voice docs [CF-voice]. A search of the installed `agents@0.30.1` dist for `gpt-live` and `live/sessions` found nothing. OpenAI lists LiveKit, Twilio, Telnyx, Bandwidth and Daily/Pipecat as partner integrations; Cloudflare is not among them [G §Partner integrations].

GPT-Live also has a third delegation target, `decisions`: Live calls OpenAI's Decisions API to pick among choices the app defines. There is also `session.triggers`, which evaluates questions as transcript deltas arrive [R-create; DV; CL "Oct 15"]. An OpenAI model makes those decisions, so they do not fit "front end only". Noted for completeness.

## 4. Where the delegation is answered: browser or server

Both connections can do it. Every delegation example is written against "a connected primary Live WebSocket or sideband" [D], and the WebRTC data channel "carries JSON events for transcripts, session updates, and delegated work" [W].

### Browser-handled

- The PWA receives `session.delegation.created` and transcripts on the data channel. It calls the household as it does for chat, then sends `session.commentary.append` back on the data channel.
- OpenAI notes that with Responses delegation "the browser can forward function-call events from its data channel to an authenticated backend for execution" [S §Decide whether you need a sideband].
- For: no outbound socket from the DO, and the existing `chat` callable is reused as it is.
- Against:
  - The browser sends any client event unless `client.data_channel.allowed_client_events` restricts it [R-create].
  - A cap or a close decided in the browser is only as reliable as the browser.
  - A closed tab ends the work's route back to voice.

### Server-handled (sideband)

- Attach with `wss://api.openai.com/v1/live/sessions/{session_id}/attach` and `Authorization: Bearer $OPENAI_API_KEY`, "using the project authentication that created … the session". Do not send `session.start` [S §Attach to the existing session; R-sideband].
- "Attaching does not create a session or replay earlier events." Attach early so no transcript is missed [R-sideband; S §Assign one owner for each action].
- On the sideband the server can [S §Observe events and send commands]:
  - receive transcripts, delegation events and nested Responses events;
  - send `session.update` (Responses settings only), the three appends, `session.input_audio.mute` / `unmute` and `session.close`.
- "If both connections receive a function-call event, execute the function once." So one owner must be chosen per action [S §Assign one owner for each action].
- The sideband **also receives reflected audio**, as `session.input_audio.append` and `session.output_audio.delta`: "base64-encoded raw mono PCM16LE at 24 kHz". The reference documents no opt-out [S §Receive reflected audio; R-sideband]. Inference, not measured: 24,000 samples/s × 2 bytes ≈ 48 KB/s per direction before base64, so roughly 128 KB/s of JSON into the DO while both sides speak.
- The openai-node sideband helper (`SidebandWS`) imports the Node `ws` package and throws if it cannot load [SDK `sideband/ws.ts`]. OpenAI's own sample also uses "an application-owned WebSocket adapter for Live sideband events" [LC README]. A Worker would therefore open the socket itself.
- On Cloudflare:
  - Workers open client WebSockets with `fetch(url, { headers: { Upgrade: "websocket" } })` and then `resp.webSocket` [CF-ws]. The page shows no `Authorization` header in that example. Inference: `fetch` accepts any headers, but the prototype must confirm the upgrade works with one.
  - "Outgoing WebSockets do not hibernate", and "an open outbound WebSocket connection prevents eviction for up to 15 minutes" [CF-DO-ws]. The household DO stays in memory, billing duration, for the whole voice session. That is acceptable for minutes on the paid plan, but the prototype should measure it.
- OpenAI's sample takes the server-owned route: the server creates the session, attaches the sideband, and runs the app-owned delegation from a transcript ledger captured "at the handoff boundary" [LC `server/session.ts` L86–L105, L243–L271].

## 5. A per-household daily minute cap

What the platform gives:

- **The server is the only one that can start a session.** Creation needs the project API key and Live has no client token (§1), so the Worker can refuse to create a session once today's minutes are spent.
- **No max-duration parameter** (§1). The session ends on `session.close`, from the primary connection or the sideband [C §Usage and graceful close; S]. `POST /live/sessions/{id}/hangup` is documented as "End a SIP call" [R-live §Hang up session]. OpenAI's sample also calls hangup on its WebRTC sessions: when startup is cancelled, and as "the bounded fallback" when `session.close` gets no `session.closed` [LC `server/session.ts` L92, L139, L476–L489]. The reference does not document that use.
- **Usage events.**
  - `session.usage.updated` carries cumulative `usage.seconds`; each update replaces the last ("Do not sum the snapshots") [C; $ §Monitor actual usage].
  - `session.closed` carries the final `usage.seconds` and `reason`.
  - "If a running connection fails before `session.closed`, retain the latest observed usage and mark final usage as unconfirmed" [C §Recover from a failed connection].
- **Idle sessions** are the application's job: "Use an application-controlled inactivity timeout" [C §Close idle sessions and resume].

OpenAI's sample enforces a cap the same way. It sets a server timer to `MAX_SESSION_SECONDS` (30–600) after attach, then calls `stop()`, which sends `session.close`. It also caps starts per minute and delegations per session. The README notes that "The session duration guard includes additional bounded startup and finalization time; it is not a hard dollar cap" [LC README; `server/session.ts` L117–L123, L476].

A shape that fits Mise (inference, for the prototype to try):

1. The household DO keeps seconds used per local day.
2. It refuses to create a session when the cap is reached, counting the 15-second initialization charge.
3. It arms an alarm or timer for the remaining allowance.
4. On the sideband it updates the running total from `session.usage.updated`, and sends `session.close` when the allowance runs out or after a silence timeout.
5. On close it records the final `usage.seconds`, or the last observed value when unconfirmed.

## 6. Facts relevant to confirmations (ADR 0024)

- OpenAI puts confirmations in the application: "Your application checks permissions, obtains required confirmations, runs functions that access your systems" [G]. "Enforce permissions and required confirmations in your application" [D §Start with your existing backend prompt]. Their guardrail example: "the refusal alone does not enforce authorization" [MIG §Adapt your guardrails].
- **Live has no UI primitive.** Delegation results are plain text for the model to use or say [D]. A Live event cannot make the client draw a button. Any button comes from the application's own UI channel. In Mise that is the existing pending confirmation, which the chat already shows and `confirm(id)` runs on a tap (`apps/worker/src/household.ts:280-300`).
- Facts that bear on a voice confirmation:
  - Text sent with `session.commentary.append` is paraphrased. "The model may paraphrase the text, and an acknowledgment does not confirm speech or playback" [D].
  - For exact wording, `session.output_audio.fixture.play` plays app-supplied audio: PCM16 at 24 kHz, at most 30 seconds, sent from the primary connection or a sideband. While it plays it interrupts model speech and mutes input, and "Input arriving during playback is dropped" [R-primary].
  - Input transcripts "may contain mistakes" [D], and a delegation carries no utterance [R-primary]. A spoken "yes" reaches Mise only as GPT-Live's transcript text, or as whatever the agent concludes from it.
  - The Decisions integration can classify transcript deltas against a `Predicate` question [R-create `triggers`; DV]. That classification is made by a model.
  - `session.input_audio.mute` mutes the caller's input without ending the session or stopping output [C §Control microphone input; S].
- No decision is made here. ADR 0024 already leaves voice confirmation to Drop 3.

## 7. Risks and unknowns the prototype still has to answer

1. **Delegation-to-speech latency.**
   - Measure the time from the end of speech to the first audio of the answer for typical turns, for example "we're out of cumin" or "swap Thursday for something with chicken".
   - Each turn runs `harness.submit` + `wait` on Haiku 5.5, sometimes with several tool rounds (`apps/worker/src/household.ts:250-253`).
   - With no documented timeout, find out what GPT-Live does during a 5–15 s wait. Does it fill, repeat itself or go quiet, and does the acknowledgement-delay trick behave?
2. **Turn reconstruction.**
   - How reliably can a complete request be cut from transcript deltas when `session.delegation.created` arrives, given "the notification may arrive before the full sentence is transcribed" [MIG]?
   - Should the DO wait, or delegate the whole recent transcript and let the agent sort it out?
   - Test corrections ("no, Friday") and back-to-back requests while a turn is still running. Mise runs a household's turns one after another (SPEC §4.7).
3. **Second brain in practice.** How often does GPT-Live answer, guess or invent a result instead of generating `<|SpawnThinking|>`? Can a prompt that delegates everything except greetings hold? Kitchen-mode questions ("how much garlic") are where it is most tempted to answer from memory.
4. **Sideband in a Durable Object.**
   - Can the DO open the attach WebSocket with an `Authorization` header via `fetch` Upgrade?
   - What does it cost the DO to parse about 128 KB/s of reflected-audio JSON it does not need?
   - What does a non-hibernating DO cost per voice minute?
   - What happens to the session when the DO is evicted or restarted mid-call (deploys)?
5. **Shared conversation.** Voice turns would join the household's single Pi conversation. Check that spoken phrasing, paraphrased answers and transcript errors don't degrade later text turns. Check what the agent should be told about where a turn came from (`where`).
6. **Duration limit and cap accuracy.**
   - Does the 2-hour limit apply to WebRTC sessions?
   - How far does billed time drift from `usage.seconds` and the 15-second initialization charge?
   - What happens to the cap when `session.closed` never arrives?
7. **Browser and PWA behaviour.**
   - WebRTC plus microphone in the installed PWA on iOS Safari and Android Chrome.
   - The audio route with the screen locked, in kitchen mode.
   - Echo when no headphones are used: OpenAI's sample advises headphones [LC README].
8. **Confirmation UX** (ADR 0024). Whether a tap on the chat sheet's button during a voice session is acceptable, and what the voice says while it waits.
9. **Access and identity.** Session creation sits behind Cloudflare Access like the rest of the Worker. The Caller for voice turns is the person whose connection started the session. Check that this holds when the sideband, not the browser, delivers the turn.
10. **Maturity.** OpenAI's own sample says compatibility "still needs verification" [LC README]. The Live API surface changed in October (Decisions on Oct 15, voices on Oct 16 [CL]), so pin the SDK version or the raw event shapes the prototype relies on.
