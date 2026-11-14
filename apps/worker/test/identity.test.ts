import { env, exports } from "cloudflare:workers";
import { AGENT_LOG_TIMEZONE_HEADER } from "@mise/domain";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";

// The test Access team and application, set as bindings in vitest.config.ts.
const team = `https://${testBinding(env.ACCESS_TEAM_DOMAIN)}`;
const audience = testBinding(env.ACCESS_AUD);
const certsUrl = `${team}/cdn-cgi/access/certs`;
const householdUrl = "https://mise.example.com/agents/household/household";
const agentLogAudience = testBinding(env.AGENT_LOG_AUD);
const agentLogClient = testBinding(env.AGENT_LOG_CLIENT_ID);

let accessKey: CryptoKey;
let strangerKey: CryptoKey;

beforeAll(async () => {
  const access = await generateKeyPair("RS256");
  accessKey = access.privateKey;
  strangerKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(access.publicKey)), kid: "access-key", alg: "RS256" };

  // Access publishes its signing keys at the team domain; serve the test key there.
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === certsUrl) return Promise.resolve(Response.json({ keys: [jwk] }));
    return realFetch(input, init);
  });
});

function testBinding(value: string | undefined): string {
  if (!value) throw new Error("vitest.config.ts must set a test Access team");
  return value;
}

/** An Access application token as Cloudflare Access issues it, with `overrides` applied. */
function accessJwt(overrides: JWTPayload = {}, key = accessKey): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: team,
    aud: [audience],
    sub: "access-user-id",
    iat: now,
    exp: now + 3600,
    email: "cook@example.com",
    type: "app",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "access-key" })
    .sign(key);
}

/** Opens a WebSocket to the household through the Worker, as the PWA does. */
async function connect(jwt?: string) {
  const headers = new Headers({ Upgrade: "websocket" });
  if (jwt) headers.set("Cf-Access-Jwt-Assertion", jwt);
  const response = await exports.default.fetch(householdUrl, { headers });
  const socket = response.webSocket;
  if (!socket) return { response, call: undefined };
  socket.accept();

  const replies = new Map<string, (reply: { success: boolean; result?: unknown; error?: string }) => void>();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "rpc") replies.get(message.id)?.(message);
  });

  /** Calls a tool over the Agents SDK's RPC protocol. */
  const call = (name: string, input: unknown) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      replies.set(id, (reply) => (reply.success ? resolve(reply.result) : reject(new Error(reply.error))));
      socket.send(JSON.stringify({ type: "rpc", id, method: "callTool", args: [name, input] }));
    });
  return { response, call };
}

describe("identity at the HTTP seam", () => {
  test("a tool call made through Access knows the caller's email", async () => {
    const { response, call } = await connect(await accessJwt());

    expect(response.status).toBe(101);
    expect(await call?.("get_caller", {})).toEqual({ ok: true, value: { email: "cook@example.com", member: null } });
  });

  test("without an Access token the household is refused", async () => {
    const { response, call } = await connect();

    expect(response.status).toBe(401);
    expect(call).toBeUndefined();
  });

  test.each([
    "/agents/household/household/rpc",
    "/agents/household/household/%0A/rpc",
    "/agents/household/household/%5C/rpc",
    // Dot segments climbing out of the paths Access bypasses resolve to the Household.
    "/cal/%2e%2e/agents/household/household",
    "/kitchen-display/v1/%2e%2e/%2e%2e/agents/household/household",
  ])("a path %s that resolves to the Household still requires Access", async (path) => {
    const response = await exports.default.fetch(new URL(path, householdUrl).href);

    expect(response.status).toBe(401);
  });

  test.each([
    // An encoded slash is not a path separator, so these stay where Access is bypassed.
    "/cal/..%2Fagents/household/household",
    "/kitchen-display/..%2F..%2Fagents/household/household",
    "/agents/household/householdx",
    "/agents/household/another-household",
  ])("a path %s that only looks like the Household never reaches it", async (path) => {
    const response = await exports.default.fetch(new URL(path, householdUrl).href);

    expect(response.status).toBe(404);
  });

  test.each([
    ["signed by someone other than Access", () => accessJwt({}, strangerKey)],
    ["for another Access application", () => accessJwt({ aud: ["another-application"] })],
    ["from another Access team", () => accessJwt({ iss: "https://elsewhere.cloudflareaccess.com" })],
    ["that has expired", () => accessJwt({ exp: Math.floor(Date.now() / 1000) - 60 })],
    ["without an email (a service token)", () => accessJwt({ email: undefined, type: "service" })],
    ["that is not a token at all", async () => "not-a-jwt"],
  ])("a token %s is refused", async (_, jwt) => {
    const { response } = await connect(await jwt());

    expect(response.status).toBe(401);
  });

  test("a client cannot claim to be someone by setting the caller header itself", async () => {
    const response = await exports.default.fetch(householdUrl, {
      headers: { Upgrade: "websocket", "Mise-Caller": JSON.stringify({ email: "intruder@example.com" }) },
    });

    expect(response.status).toBe(401);
  });

  test("the caller's email is normalised to lower case", async () => {
    const { call } = await connect(await accessJwt({ email: "Cook@Example.com" }));

    expect(await call?.("get_caller", {})).toEqual({ ok: true, value: { email: "cook@example.com", member: null } });
  });

  test("the calendar feed does not ask for sign-in", async () => {
    const response = await exports.default.fetch("https://mise.example.com/cal/some-token.ics");

    expect(response.status).not.toBe(401);
  });
});

/** A token as Access issues it for a service token: no email, and the token's client id as `common_name`. */
function serviceTokenJwt(overrides: JWTPayload = {}): Promise<string> {
  return accessJwt({ aud: [agentLogAudience], email: undefined, sub: "", common_name: agentLogClient, ...overrides });
}

/** Asks for the agent log through the Worker, with `jwt` as Access's token if given. */
function agentLog(jwt?: string, query = ""): Promise<Response> {
  return exports.default.fetch(`https://mise.example.com/agent-log${query}`, {
    headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
  });
}

describe("the agent log", () => {
  test("answers the agent log's service token with the Household's conversation", async () => {
    const response = await agentLog(await serviceTokenJwt(), "?turns=3");

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
    expect(Object.keys(await response.json()).sort()).toEqual([
      "pending_confirmation",
      "pi_entries",
      "voice_exchange",
      "voice_session",
    ]);
  });

  test.each([
    ["no token", async () => undefined],
    ["a Member's token", () => accessJwt()],
    ["a Member's token for the agent log", () => accessJwt({ aud: [agentLogAudience] })],
    ["the service token's for another application", () => serviceTokenJwt({ aud: [audience] })],
    ["another service token's", () => serviceTokenJwt({ common_name: "someone-else.access" })],
    ["one signed by someone other than Access", () => accessJwt({}, strangerKey)],
  ])("is not found with %s", async (_, jwt) => {
    const response = await agentLog(await jwt());

    expect(response.status).toBe(404);
  });

  test("refuses a number of turns that isn't a positive whole number", async () => {
    for (const turns of ["0", "-1", "2.5", "many"]) {
      expect((await agentLog(await serviceTokenJwt(), `?turns=${turns}`)).status).toBe(400);
    }
  });

  test("answers a time to give the conversation since", async () => {
    const response = await agentLog(await serviceTokenJwt(), "?since=2026-11-06T08:00:00.000Z");

    expect(response.status).toBe(200);
    // The log's days are the Household's, which `--totals` counts by.
    expect(response.headers.get(AGENT_LOG_TIMEZONE_HEADER)).toBe("UTC");
    expect(Object.keys(await response.json()).sort()).toEqual([
      "pending_confirmation",
      "pi_entries",
      "voice_exchange",
      "voice_session",
    ]);
  });

  test("refuses a time that isn't an ISO 8601 one, and both a time and a number of turns", async () => {
    for (const query of ["?since=yesterday", "?since=2026-13-40", "?since=", "?since=2026-11-06&turns=3"]) {
      expect((await agentLog(await serviceTokenJwt(), query)).status).toBe(400);
    }
  });
});
