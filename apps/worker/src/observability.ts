import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import type { CloudflareOptions, Event } from "@sentry/cloudflare";
import * as Sentry from "@sentry/cloudflare";

type StreamedSpan = Parameters<NonNullable<CloudflareOptions["beforeSendSpan"]>>[0];

/** Request headers worth seeing in an error report. Everything else may identify a Member. */
const SAFE_HEADERS = new Set(["accept", "content-length", "content-type"]);

/**
 * Span attributes that carry what someone said or what the model said back: prompts, responses,
 * instructions and tool arguments. Model names and token counts stay.
 */
const CONTENT_ATTRIBUTE =
  /^gen_ai\.(prompt|completion|request\.messages|input\.messages|output\.messages|response\.text|system_instructions|tool\.(call\.)?(arguments|result|input|output))/;

/** Attributes that carry request bodies or query strings. */
const REQUEST_ATTRIBUTE = /^(http\.request\.body|http\.query|url\.query)/;

/** Attributes holding a URL, kept without its query string. */
const URL_ATTRIBUTE = /^(url\.|http\.(url|target)$)/;

/**
 * The Calendar Feed's token, whose path is its only secret (ADR 0019). Tokens are base64url,
 * percent-encoded at worst, so the match takes only that and keeps what follows, ".ics" included.
 */
const FEED_TOKEN = /\/cal\/[A-Za-z0-9_%-]+/g;

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
    // Spans are scrubbed only as they stream; the SDK would otherwise take this from SENTRY_TRACE_LIFECYCLE.
    traceLifecycle: "stream",
    beforeSend: scrubEvent,
    beforeSendSpan: scrubSpan,
  };
}

/** Strips anything that could identify the Household from an error event. */
export function scrubEvent<T extends Event>(event: T): T {
  return withoutFeedTokens(scrubEventFields(event));
}

function scrubEventFields<T extends Event>(event: T): T {
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

/** Strips prompts, model output, tool arguments, request bodies, query strings and the Calendar Feed's token from a span. */
export function scrubSpan(span: StreamedSpan): StreamedSpan {
  try {
    return scrubSpanFields(span);
  } catch {
    // Sentry sends a span its callback threw on as it was, so one that can't be scrubbed keeps only its ids and timing.
    const { trace_id, parent_span_id, span_id, start_timestamp, end_timestamp, status, is_segment } = span;
    return {
      trace_id,
      parent_span_id,
      span_id,
      start_timestamp,
      end_timestamp,
      status,
      is_segment,
      name: "[scrubbed]",
      attributes: {},
    };
  }
}

function scrubSpanFields(span: StreamedSpan): StreamedSpan {
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (CONTENT_ATTRIBUTE.test(key) || REQUEST_ATTRIBUTE.test(key)) continue;
    attributes[key] = typeof value === "string" && URL_ATTRIBUTE.test(key) ? withoutQuery(value) : value;
  }
  return withoutFeedTokens({ ...span, attributes });
}

function withoutQuery(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

/**
 * Every string in `value` without the Calendar Feed's token. The token can surface in any field
 * Sentry fills from the request (URLs, span and transaction names, tags, trace context), so all of
 * them are searched, except the SDK's own `sdkProcessingMetadata`, which it reads afterwards and
 * never sends. A value seen before is replaced by what it became, so a cycle stays a cycle.
 */
function withoutFeedTokens<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value === "string") return value.replace(FEED_TOKEN, "/cal/[token]") as T;
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return seen.get(value) as T;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    seen.set(value, items);
    for (const item of value) items.push(withoutFeedTokens(item, seen));
    return items as T;
  }
  const entries: Record<string, unknown> = {};
  seen.set(value, entries);
  for (const [key, item] of Object.entries(value)) {
    entries[key] = key === "sdkProcessingMetadata" ? item : withoutFeedTokens(item, seen);
  }
  return entries as T;
}

type TelemetryContext = NonNullable<HarnessOptions["telemetry"]>;
type TelemetrySpan = Parameters<Parameters<TelemetryContext["startSpan"]>[1]>[0];
type PiAttributes = NonNullable<Parameters<TelemetrySpan["setAttributes"]>[0]>;
type SpanAttributes = NonNullable<Parameters<Sentry.Span["setAttributes"]>[0]>;

/** What the agent's traces use of a Sentry span. */
export type SentrySpan = {
  setAttributes(attributes: SpanAttributes): unknown;
  setStatus(status: { code: 1 | 2; message?: string }): unknown;
  addEvent(name: string, attributes: SpanAttributes): unknown;
};

/** Sentry's `startSpan`, as far as the agent's traces use it. */
export type StartSpan = <T>(
  options: { name: string; op: string; attributes: SpanAttributes },
  callback: (span: SentrySpan) => T,
) => T;

/**
 * pi's telemetry as Sentry spans: agent runs (`pi.durable.*`) and model requests (`pi.ai.request`),
 * which tool calls (`mise.tool`) nest under. pi records only ids, model names, token counts and the
 * like, never what anyone said; a failure keeps only that it failed, since a provider's error text
 * can quote the prompt.
 */
export function sentryTelemetry(startSpan: StartSpan = Sentry.startSpan as StartSpan): TelemetryContext {
  const telemetry: TelemetryContext = {
    startSpan: (options, callback) =>
      Promise.resolve(
        startSpan({ name: options.name, op: options.name, attributes: defined(options.attributes) }, (span) =>
          callback({
            ...telemetry,
            setAttributes: (attributes) => void span.setAttributes(defined(attributes)),
            setStatus: (status) =>
              void span.setStatus(status.status === "ok" ? { code: 1 } : { code: 2, message: "internal_error" }),
            addEvent: (name, attributes) => void span.addEvent(name, defined(attributes)),
            // Links name other pi spans, which Sentry has no handle on.
            addLink: () => {},
          }),
        ),
      ),
  };
  return telemetry;
}

function defined(attributes: PiAttributes | undefined): SpanAttributes {
  return Object.fromEntries(
    Object.entries(attributes ?? {}).filter(([, value]) => value !== undefined),
  ) as SpanAttributes;
}

type OnReport = NonNullable<HarnessOptions["onReport"]>;
type ReportInfo = Parameters<OnReport>[0];

/** Sentry's `captureMessage`, as far as pi's reports use it. */
export type CaptureMessage = (message: string, context: { level: "error"; tags: Record<string, string> }) => unknown;

/**
 * pi's reports of its own failures (failed storage, a task that faulted or was interrupted, an
 * extension or host callback that threw) as Sentry messages: what happened, and the task kind,
 * extension and callback it names, never the error, whose text can quote what someone said.
 */
export function piReports(capture: CaptureMessage = Sentry.captureMessage as CaptureMessage): OnReport {
  return (info) => void capture(`pi ${info.kind}`, { level: "error", tags: reportTags(info) });
}

function reportTags(info: ReportInfo): Record<string, string> {
  const named = info as { task?: { kind: string }; extension?: string; reason?: string; callback?: string };
  return Object.fromEntries(
    Object.entries({
      "pi.report": info.kind,
      "pi.task": named.task?.kind,
      "pi.extension": named.extension,
      "pi.reason": named.reason,
      "pi.callback": named.callback,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/**
 * Reports pi failing to wake (as when it cannot be opened) to Sentry, without the error's text. The
 * harness retries the wake itself; this makes a run of failures visible. Returns how to stop.
 */
export function reportWakeErrors(capture: CaptureMessage = Sentry.captureMessage as CaptureMessage): () => void {
  const lifecycle = (event: unknown) => {
    if ((event as { type?: unknown }).type !== "pi:wake_error") return;
    capture("pi wake_error", { level: "error", tags: { "pi.report": "wake_error" } });
  };
  subscribe("agents:lifecycle", lifecycle);
  return () => void unsubscribe("agents:lifecycle", lifecycle);
}
