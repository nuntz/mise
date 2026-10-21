import { env, exports } from "cloudflare:workers";
import { exportJWK, generateKeyPair, type JWTPayload, SignJWT } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";

// The test Access team and application, set as bindings in vitest.config.ts.
const team = `https://${testBinding(env.ACCESS_TEAM_DOMAIN)}`;
const audience = testBinding(env.ACCESS_AUD);
const certsUrl = `${team}/cdn-cgi/access/certs`;
const householdUrl = "https://mise.example.com/agents/household/household";

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
    expect(await call?.("get_caller", {})).toEqual({ ok: true, value: { email: "cook@example.com" } });
  });

  test("without an Access token the household is refused", async () => {
    const { response, call } = await connect();

    expect(response.status).toBe(401);
    expect(call).toBeUndefined();
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

    expect(await call?.("get_caller", {})).toEqual({ ok: true, value: { email: "cook@example.com" } });
  });

  test("the calendar feed does not ask for sign-in", async () => {
    const response = await exports.default.fetch("https://mise.example.com/cal/some-token.ics");

    expect(response.status).not.toBe(401);
  });
});
