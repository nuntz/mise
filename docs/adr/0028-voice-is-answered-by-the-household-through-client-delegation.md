# Voice is answered by the household through client delegation over a sideband

GPT-Live-1 is only the voice of Mise: it listens, speaks and decides when to ask, and the Household's own agent does all the reasoning and every tool call. The Worker creates the Live session by relaying the browser's SDP offer with the OpenAI key (Live has no client token). The household then attaches a sideband WebSocket to that session and holds it for as long as the session lasts. On each `session.delegation.created` the household cuts a turn from the input transcript, everything said since the last cut. It runs that turn through the same path as the chat, as the Caller who started the session, and returns the agent's answer with `session.commentary.append` for GPT-Live to paraphrase aloud. The same socket counts `session.usage.updated` toward the Household's daily minutes and sends `session.close` when they run out. The browser keeps only the audio, on WebRTC. The spike (docs/research/gpt-live-1-backend-agent.md, "Spike results") measured about 4 s from the person's last word to the answer. GPT-Live answered on its own only for greetings and backchannels.

## Considered Options

- **The browser answers delegations** from its data channel by calling `chat`. There would be no outbound socket in the household, but the cap and the close would then be only as reliable as the browser, and a closed tab would lose the answer's way back to voice.
- **Responses delegation with one `ask_mise_agent` function.** The request would arrive as a structured argument, but a second OpenAI model would reason on every turn, cost tokens and see Mise's conversation. That is the second brain SPEC rules out.
- **Chained STT → agent → TTS** (Cloudflare `agents/voice`). There is no OpenAI in it at all, but it is not full duplex, and every turn would sit silent until the agent answered.

## Consequences

- The household stays in memory for the whole session, because an outbound WebSocket does not hibernate. It also receives about 120 KB/s of reflected audio that it drops unread.
- A deploy or restart drops the sideband. The household does not reattach. The browser ends the session and the last usage seen is counted, marked unconfirmed.
- Turn segmentation is Mise's job: the delegation event carries no utterance. A backchannel GPT-Live answered itself is carried into the next turn. A delegation that arrives while a turn runs waits as its own turn.
- One Voice Session per Household at a time, so there is one sideband and one cap timer.
- GPT-Live still decides when to delegate, and no setting stops it answering on its own. Its instructions delegate everything but greetings and backchannels. Every change goes through the agent's tools, so a turn it answers itself changes nothing.
