import { HOUSEHOLD_PATH } from "@mise/domain";
import * as Sentry from "@sentry/cloudflare";
import { routeAgentRequest } from "agents";
import { resolveCaller, withCaller } from "./identity";
import { sentryOptions } from "./observability";

export { Household } from "./household";

export default Sentry.withSentry(sentryOptions, {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    // The calendar feed bypasses Access and carries its own token; nothing serves it yet.
    if (pathname.startsWith("/cal/")) return new Response("Not found", { status: 404 });
    // One household per deployment: refuse any other agent instance.
    if (pathname !== HOUSEHOLD_PATH && !pathname.startsWith(`${HOUSEHOLD_PATH}/`)) {
      return new Response("Not found", { status: 404 });
    }
    const caller = await resolveCaller(request, env);
    if (!caller) return new Response("Sign in through Cloudflare Access", { status: 401 });
    return (await routeAgentRequest(withCaller(request, caller), env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>);
