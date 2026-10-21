import { Caller } from "@mise/domain";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

/** The header Cloudflare Access puts its signed identity token in. */
const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

/** Signing keys per Access team, fetched once per isolate and refreshed by jose when they rotate. */
const keySets = new Map<string, JWTVerifyGetKey>();

/**
 * Who sent this request, or null if no one we trust vouched for them. Behind Access, that is the
 * email in a token signed by the deployment's Access team for this application; the Worker checks
 * it rather than trusting Access alone, so a route Access does not cover still has no identity.
 * Without Access configured, only `wrangler dev` with `DEV_CALLER_EMAIL` has a caller.
 */
export async function resolveCaller(request: Request, env: Env): Promise<Caller | null> {
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    return verifyAccessJwt(request.headers.get(ACCESS_JWT_HEADER), env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  }
  return env.DEV_CALLER_EMAIL ? { email: env.DEV_CALLER_EMAIL.toLowerCase() } : null;
}

async function verifyAccessJwt(jwt: string | null, teamDomain: string, audience: string): Promise<Caller | null> {
  if (!jwt) return null;
  const issuer = `https://${teamDomain.replace(/^https:\/\//, "").replace(/\/$/, "")}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(jwt, keys, { issuer, audience, algorithms: ["RS256"] });
    // Service tokens carry no email; only people are callers.
    return typeof payload.email === "string" ? { email: payload.email.toLowerCase() } : null;
  } catch {
    return null;
  }
}

/**
 * Carries the resolved Caller from the Worker to the household Durable Object. Only the Worker can
 * reach the Durable Object, and it always overwrites this header, so a client cannot set it.
 */
export const CALLER_HEADER = "Mise-Caller";

/** The request as the Worker forwards it to the household: stamped with who sent it. */
export function withCaller(request: Request, caller: Caller): Request {
  const headers = new Headers(request.headers);
  headers.set(CALLER_HEADER, JSON.stringify(caller));
  return new Request(request, { headers });
}

/** The Caller the Worker stamped on a request it forwarded, if any. */
export function callerFrom(request: Request): Caller | null {
  const header = request.headers.get(CALLER_HEADER);
  if (!header) return null;
  try {
    const caller = Caller.safeParse(JSON.parse(header));
    return caller.success ? caller.data : null;
  } catch {
    return null;
  }
}
