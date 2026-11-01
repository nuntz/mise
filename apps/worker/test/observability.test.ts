import { channel } from "node:diagnostics_channel";
import { type ErrorEvent, Scope } from "@sentry/cloudflare";
import { describe, expect, test } from "vitest";
import {
  piReports,
  reportWakeErrors,
  type SentrySpan,
  scrubEvent,
  scrubSpan,
  sentryOptions,
  sentryTelemetry,
} from "../src/observability";

describe("Sentry scrubbing", () => {
  test("an error event keeps what went wrong and drops who it happened to", () => {
    const event: ErrorEvent = {
      type: undefined,
      message: "Something broke",
      user: { email: "parent@example.com", ip_address: "203.0.113.7" },
      request: {
        url: "https://mise.example.com/agents/household/household/restore?token=secret",
        method: "POST",
        data: '{"name":"The Example Family"}',
        cookies: { CF_Authorization: "jwt" },
        query_string: "token=secret",
        headers: {
          "Cf-Access-Jwt-Assertion": "jwt",
          "Cf-Access-Authenticated-User-Email": "parent@example.com",
          Cookie: "CF_Authorization=jwt",
          "Content-Type": "application/json",
        },
      },
      extra: { input: { name: "The Example Family" } },
      breadcrumbs: [
        { category: "console", message: "Error on server: The Example Family" },
        { category: "fetch", data: { url: "https://r2.example.com/photos?prefix=x", status_code: 500 } },
      ],
    };

    expect(scrubEvent(event)).toEqual({
      type: undefined,
      message: "Something broke",
      request: {
        url: "https://mise.example.com/agents/household/household/restore",
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      breadcrumbs: [{ category: "fetch" }],
    });
  });

  test("a span keeps model usage and drops prompts, responses and tool arguments", () => {
    const span: Parameters<typeof scrubSpan>[0] = {
      span_id: "1",
      trace_id: "2",
      name: "chat claude-haiku-5-5",
      start_timestamp: 0,
      status: "ok",
      is_segment: false,
      attributes: {
        "gen_ai.request.model": "claude-haiku-5-5",
        "gen_ai.usage.input_tokens": 120,
        "gen_ai.request.messages": '[{"role":"user","content":"No peanuts for Sam"}]',
        "gen_ai.input.messages": "…",
        "gen_ai.output.messages": "…",
        "gen_ai.response.text": "Here is a peanut-free week",
        "gen_ai.system_instructions": "You plan meals for…",
        "gen_ai.tool.call.arguments": '{"name":"Sam"}',
        "gen_ai.tool.call.result": "{}",
        "http.request.body": "{}",
        "url.query": "token=secret",
        "url.full": "https://mise.example.com/agents/household/household?_pk=abc",
      },
    };

    expect(scrubSpan(span).attributes).toEqual({
      "gen_ai.request.model": "claude-haiku-5-5",
      "gen_ai.usage.input_tokens": 120,
      "url.full": "https://mise.example.com/agents/household/household",
    });
  });

  describe("the Calendar Feed's token", () => {
    const TOKEN = "k9X2mQ7vLp4RtW8nZ3bY";

    function feedSpan(overrides: Partial<Parameters<typeof scrubSpan>[0]> = {}): Parameters<typeof scrubSpan>[0] {
      return {
        span_id: "1",
        trace_id: "2",
        name: "GET",
        start_timestamp: 0,
        status: "ok",
        is_segment: true,
        attributes: {},
        ...overrides,
      };
    }

    test("is redacted from a span's URL attributes, absolute or relative", () => {
      const span = feedSpan({
        attributes: {
          "url.full": `https://mise.example.com/cal/${TOKEN}.ics`,
          "url.path": `/cal/${TOKEN}.ics`,
          "http.response.status_code": 200,
        },
      });

      expect(scrubSpan(span).attributes).toEqual({
        "url.full": "https://mise.example.com/cal/[token].ics",
        "url.path": "/cal/[token].ics",
        "http.response.status_code": 200,
      });
    });

    test("is redacted from a span named after the request", () => {
      const span = feedSpan({ name: `GET /cal/${TOKEN}.ics` });

      expect(scrubSpan(span).name).toBe("GET /cal/[token].ics");
    });

    test("is redacted without taking what follows it", () => {
      const span = feedSpan({ name: `fetch /cal/${TOKEN}.ics: 500` });

      expect(scrubSpan(span).name).toBe("fetch /cal/[token].ics: 500");
    });

    test("is redacted alone, leaving the quotes and brackets around it", () => {
      expect(scrubSpan(feedSpan({ name: `{"url":"/cal/${TOKEN}.ics","status":500}` })).name).toBe(
        '{"url":"/cal/[token].ics","status":500}',
      );
      expect(scrubSpan(feedSpan({ name: `fetch(/cal/${TOKEN}.ics) failed` })).name).toBe(
        "fetch(/cal/[token].ics) failed",
      );
    });

    test("is never sent when a span cannot be scrubbed", () => {
      const unreadable = {
        get value(): string {
          throw new Error("unreadable");
        },
      };
      const span = feedSpan({ name: `GET /cal/${TOKEN}.ics`, attributes: { "url.path": `/cal/${TOKEN}.ics` } });
      span.links = [{ context: unreadable } as never];

      const scrubbed = scrubSpan(span);

      expect(scrubbed).toMatchObject({ span_id: "1", trace_id: "2", attributes: {} });
      expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    });

    test("is redacted from an error event holding a cycle, and the SDK's own metadata is left as it is", () => {
      const scope = new Scope();
      const data: Record<string, unknown> = { url: `/cal/${TOKEN}.ics` };
      data.self = data;
      const event: ErrorEvent = {
        type: undefined,
        message: "Something broke",
        contexts: { feed: data },
        sdkProcessingMetadata: { capturedSpanScope: scope },
      };

      const scrubbed = scrubEvent(event);

      expect(scrubbed.contexts?.feed?.url).toBe("/cal/[token].ics");
      expect(scrubbed.sdkProcessingMetadata?.capturedSpanScope).toBe(scope);
    });

    test("is redacted from an error raised while serving the feed", () => {
      const event: ErrorEvent = {
        type: undefined,
        message: "Something broke",
        transaction: `GET /cal/${TOKEN}.ics`,
        request: { url: `https://mise.example.com/cal/${TOKEN}.ics`, method: "GET" },
      };

      expect(scrubEvent(event)).toMatchObject({
        transaction: "GET /cal/[token].ics",
        request: { url: "https://mise.example.com/cal/[token].ics", method: "GET" },
      });
    });

    test("appears nowhere in what is sent", () => {
      const attributes = {
        "url.full": `https://mise.example.com/cal/${TOKEN}.ics?refresh=1#top`,
        "url.path": `/cal/${TOKEN}.ics`,
        "http.target": `/cal/${TOKEN}.ics`,
        "sentry.op": "http.server",
      };
      const event: ErrorEvent = {
        type: undefined,
        message: "Something broke",
        transaction: `GET /cal/${TOKEN}.ics`,
        request: { url: `https://mise.example.com/cal/${TOKEN}.ics`, method: "GET" },
        contexts: { trace: { trace_id: "2", span_id: "1", op: "http.server", data: attributes } },
        tags: { transaction: `GET /cal/${TOKEN}.ics` },
      };
      const span = feedSpan({ name: `GET /cal/${TOKEN}.ics`, attributes });

      expect(JSON.stringify(scrubEvent(event))).not.toContain(TOKEN);
      expect(JSON.stringify(scrubSpan(span))).not.toContain(TOKEN);
    });
  });

  test("the SDK collects no personal data and runs without a DSN", () => {
    const options = sentryOptions({} as Env);

    expect(options).toMatchObject({
      dsn: undefined,
      dataCollection: { userInfo: false, cookies: false, httpBodies: [], genAI: { inputs: false, outputs: false } },
      // Spans are scrubbed as they stream, whatever SENTRY_TRACE_LIFECYCLE says.
      traceLifecycle: "stream",
    });
  });
});

describe("the agent's traces", () => {
  /** A stand-in for Sentry's `startSpan` that keeps what each span was given. */
  function recordingTracer() {
    const spans: { name: string; op?: string; attributes?: unknown; status?: unknown; events: unknown[] }[] = [];
    const startSpan = <T>(
      options: { name: string; op?: string; attributes?: Record<string, unknown> },
      callback: (span: SentrySpan) => T,
    ): T => {
      const recorded = { ...options, events: [] as unknown[], status: undefined as unknown };
      spans.push(recorded);
      const span: SentrySpan = {
        setAttributes(attributes) {
          recorded.attributes = { ...(recorded.attributes as object), ...attributes };
        },
        setStatus(status) {
          recorded.status = status;
        },
        addEvent(name, attributes) {
          recorded.events.push({ name, attributes });
        },
      };
      return callback(span);
    };
    return { spans, startSpan };
  }

  test("pi's runs and model requests become Sentry spans, nested, with their content-free attributes", async () => {
    const tracer = recordingTracer();
    const telemetry = sentryTelemetry(tracer.startSpan);

    const answer = await telemetry.startSpan({ name: "pi.durable.phase", attributes: { phase: "generate" } }, (run) =>
      run.startSpan(
        { name: "pi.ai.request", attributes: { model: "claude-haiku-5-5", reasoning: undefined } },
        (request) => {
          request.setAttributes({ "usage.input": 120 });
          request.addEvent("pi.ai.first_chunk");
          return "answered";
        },
      ),
    );

    expect(answer).toBe("answered");
    expect(tracer.spans).toEqual([
      { name: "pi.durable.phase", op: "pi.durable.phase", attributes: { phase: "generate" }, events: [] },
      {
        name: "pi.ai.request",
        op: "pi.ai.request",
        attributes: { model: "claude-haiku-5-5", "usage.input": 120 },
        events: [{ name: "pi.ai.first_chunk", attributes: {} }],
      },
    ]);
  });

  test("a failed span keeps that it failed, not the provider's error text", async () => {
    const tracer = recordingTracer();

    await sentryTelemetry(tracer.startSpan).startSpan({ name: "pi.ai.request" }, (span) =>
      span.setStatus({ status: "error", error: { name: "ProviderError", message: "Robin asked about peanuts" } }),
    );

    expect(tracer.spans[0]?.status).toEqual({ code: 2, message: "internal_error" });
  });
});

describe("pi's own failures", () => {
  /** A stand-in for Sentry's `captureMessage` that keeps what each report was given. */
  function recordingCapture() {
    const reports: { message: string; context: unknown }[] = [];
    const capture = (message: string, context: unknown) => void reports.push({ message, context });
    return { reports, capture };
  }

  test("a task pi parked or that faulted reaches Sentry by its kind, never by its error", () => {
    const { reports, capture } = recordingCapture();
    const onReport = piReports(capture);
    const task = { id: 7 as never, kind: "pi.tool", conversationId: 1 as never };

    onReport(new Error("Robin asked about peanuts"), {
      type: "task_faulted",
      task,
      extension: "mise",
      reason: "threw",
    });
    onReport(new Error("Robin asked about peanuts"), { type: "task_parked", task, extension: "mise" });
    onReport(new Error("Robin asked about peanuts"), { type: "session_failed" });

    expect(reports).toEqual([
      {
        message: "pi task_faulted",
        context: {
          level: "error",
          tags: { "pi.report": "task_faulted", "pi.task": "pi.tool", "pi.extension": "mise", "pi.reason": "threw" },
        },
      },
      {
        message: "pi task_parked",
        context: { level: "error", tags: { "pi.report": "task_parked", "pi.task": "pi.tool", "pi.extension": "mise" } },
      },
      { message: "pi session_failed", context: { level: "error", tags: { "pi.report": "session_failed" } } },
    ]);
  });

  test("pi failing to wake reaches Sentry, without the error's text", () => {
    const { reports, capture } = recordingCapture();
    const stop = reportWakeErrors(capture);

    channel("agents:lifecycle").publish({ type: "pi:wake_error", payload: { error: "Robin asked about peanuts" } });
    channel("agents:lifecycle").publish({ type: "pi:something_else", payload: {} });
    stop();
    channel("agents:lifecycle").publish({ type: "pi:wake_error", payload: { error: "after stopping" } });

    expect(reports).toEqual([
      { message: "pi wake_error", context: { level: "error", tags: { "pi.report": "wake_error" } } },
    ]);
  });
});
