import { bearerToken, calendarTokenOf, DAY_SHEET_PATH, HOUSEHOLD_AGENT, HOUSEHOLD_PATH } from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { routeAgentRequest } from "agents";
import { resolveCaller, withCaller } from "./identity";
import { sentryOptions } from "./observability";

export { Household } from "./household";

export default Sentry.withSentry(sentryOptions, {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // The calendar feed bypasses Access and carries its own token (ADR 0019).
    if (pathname.startsWith("/cal/")) return calendarFeed(request, env);
    // So does the Day Sheet, whose token comes in the Authorization header (ADR 0027). Access may
    // bypass the paths under it too, so the Worker answers those itself rather than serve the app.
    if (pathname === DAY_SHEET_PATH) return daySheet(request, env);
    if (pathname.startsWith("/kitchen-display/")) return json({ error: "not_found" }, 404);
    // One household per deployment: refuse any other agent instance.
    if (pathname !== HOUSEHOLD_PATH && !pathname.startsWith(`${HOUSEHOLD_PATH}/`)) {
      return new Response("Not found", { status: 404 });
    }
    const caller = await resolveCaller(request, env);
    if (!caller) return new Response("Sign in through Cloudflare Access", { status: 401 });
    return (await routeAgentRequest(withCaller(request, caller), env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>);

async function calendarFeed(request: Request, env: Env): Promise<Response> {
  const token = calendarTokenOf(new URL(request.url).pathname);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  const household = env.Household.getByName(HOUSEHOLD_AGENT.name);
  const feed = token && (await household.calendarFeed(token, new URL(request.url).origin));
  // The same answer for a wrong token as for no feed at all.
  if (!feed) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : feed, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      // The URL is the secret: keep it and the plan out of shared caches and search engines.
      "Cache-Control": "private, no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

/** A Kitchen Display's Day Sheet: always JSON, never a redirect, whatever the answer. */
async function daySheet(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { Allow: "GET" });
  const token = bearerToken(request.headers.get("Authorization"));
  const answer = token ? await env.Household.getByName(HOUSEHOLD_AGENT.name).daySheet(token) : null;
  if (!answer || answer.status === "unauthorized") {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": "Bearer" });
  }
  if (answer.status === "not_set_up") return json({ error: "not_set_up" }, 409);
  return json(answer.daySheet, 200);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    // The plan is the Household's: keep it out of shared caches.
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-cache", ...headers },
  });
}
