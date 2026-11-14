# The agent reads the deployed Household's conversation with a service token of its own

When a voice or agent hand test fails, the agent debugging it needs to see what the deployed Household heard, said and did. Sentry carries no chat content and no tool calls, and nothing recorded what GPT-Live said without handing on (#117). So `GET /agent-log?turns=N` returns the raw rows `bun run transcript` formats: the latest Member turns' Pi entries, the Pending Confirmations and Voice Session exchanges since the first of them, and the Voice Sessions from that first turn's Household-local day on (a Voice Session keeps only its day), so a review can total the stretch's voice time. It is read-only. The Worker routes it before it resolves a Caller, and calls a household RPC method, `agentLog(turns)`, which is not `@callable` and runs no tool, as the Calendar Feed (ADR 0019) and the Day Sheet (ADR 0027) do.

`/agent-log` has an Access application of its own, whose only policy admits one Access service token, which Pulumi makes. No Member sign-in reaches it. The Worker checks the token itself too, as ADR 0007 does for Members: the Access token must be valid for that application's audience, and its `common_name` must be the service token's client id. Anyone else gets a 404, a Member included. The service token is never a Caller.

The Household's own conversation may therefore reach the agent's terminal and context, read-only, when the person runs `bun run transcript --deployed`. It never goes into git, Sentry, CI logs or the Backup. The client id and secret are Pulumi outputs, which `bun run wizard` keeps in `~/.config/mise/deploy.env` (ADR 0005).

## Consequences

- What GPT-Live heard and said in each exchange of a Voice Session is kept in `voice_exchange`, the latest 300 only. It is conversation, not Household data, so the Backup leaves it out (ADR 0006).
- The service token expires a year after Pulumi makes it. Access then refuses it, and the token must be rotated and the wizard re-run.
- `AGENT_LOG_AUD` and `AGENT_LOG_CLIENT_ID` are Worker secrets that Pulumi computes. Without them, as under `wrangler dev`, the route answers 404 to everyone, and `bun run transcript` reads the local store instead.
