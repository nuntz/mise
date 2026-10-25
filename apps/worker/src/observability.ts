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
type ReportInfo = Parameters<OnReport>[1];

/** Sentry's `captureMessage`, as far as pi's reports use it. */
export type CaptureMessage = (message: string, context: { level: "error"; tags: Record<string, string> }) => unknown;

/**
 * pi's reports of its own failures (a failed session, a task that faulted or that its restart limit
 * parked, an extension or host callback that threw) as Sentry messages: what happened, and the task
 * kind, extension and callback it names, never the error, whose text can quote what someone said.
 * A parked task waits for `retry()`, run by hand.
 */
export function piReports(capture: CaptureMessage = Sentry.captureMessage as CaptureMessage): OnReport {
  return (_error, info) => void capture(`pi ${info.type}`, { level: "error", tags: reportTags(info) });
}

function reportTags(info: ReportInfo): Record<string, string> {
  const named = info as { task?: { kind: string }; extension?: string; reason?: string; callback?: string };
  return Object.fromEntries(
    Object.entries({
      "pi.report": info.type,
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
