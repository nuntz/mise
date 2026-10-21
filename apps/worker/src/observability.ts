import type { CloudflareOptions, Event } from "@sentry/cloudflare";

type StreamedSpan = Parameters<NonNullable<CloudflareOptions["beforeSendSpan"]>>[0];

/** Request headers worth seeing in an error report. Everything else may identify a Member. */
const SAFE_HEADERS = new Set(["accept", "content-length", "content-type"]);

/**
 * Span attributes that carry what someone said or what the model said back: prompts, responses,
 * instructions and tool arguments. Model names and token counts stay.
 */
const CONTENT_ATTRIBUTE =
  /^gen_ai\.(prompt|completion|request\.messages|input\.messages|output\.messages|response\.text|system_instructions|tool\.(call\.)?(arguments|result|input|output))/;

/** Attributes that carry request bodies or query strings (calendar tokens travel in the URL). */
const REQUEST_ATTRIBUTE = /^(http\.request\.body|http\.query|url\.query)/;

/** Attributes holding a URL, kept without its query string. */
const URL_ATTRIBUTE = /^(url\.|http\.(url|target)$)/;

/** Sentry for the Worker and the household Durable Object. No DSN, no reporting. */
export function sentryOptions(env: Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    // A single Household makes little traffic: trace every request so slow ones are visible.
    tracesSampleRate: 1,
    // Collect nothing about people or what they said; the scrubbers below catch anything that slips through.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: [...SAFE_HEADERS] }, response: { allow: [...SAFE_HEADERS] } },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    beforeSendSpan: scrubSpan,
  };
}

/** Strips anything that could identify the Household from an error or transaction event. */
export function scrubEvent<T extends Event>(event: T): T {
  const { user: _user, extra: _extra, breadcrumbs, ...scrubbed } = event;
  // Console breadcrumbs repeat whatever was logged; other breadcrumbs keep only their category.
  const rest = {
    ...scrubbed,
    ...(breadcrumbs && {
      breadcrumbs: breadcrumbs
        .filter((breadcrumb) => breadcrumb.category !== "console")
        .map(({ data: _data, message: _message, ...breadcrumb }) => breadcrumb),
    }),
  };
  if (!rest.request) return rest as T;
  const { data: _data, cookies: _cookies, query_string: _query, headers, url, ...request } = rest.request;
  return {
    ...rest,
    request: {
      ...request,
      ...(url && { url: withoutQuery(url) }),
      ...(headers && {
        headers: Object.fromEntries(Object.entries(headers).filter(([name]) => SAFE_HEADERS.has(name.toLowerCase()))),
      }),
    },
  } as T;
}

/** Strips prompts, model output, tool arguments, request bodies and query strings from a span. */
export function scrubSpan(span: StreamedSpan): StreamedSpan {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (CONTENT_ATTRIBUTE.test(key) || REQUEST_ATTRIBUTE.test(key)) continue;
    attributes[key] = typeof value === "string" && URL_ATTRIBUTE.test(key) ? withoutQuery(value) : value;
  }
  return { ...span, attributes };
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}
