import type { ErrorEvent } from "@sentry/cloudflare";
import { describe, expect, test } from "vitest";
import { scrubEvent, scrubSpan, sentryOptions } from "../src/observability";

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
        "url.full": "https://mise.example.com/cal/feed.ics?token=secret",
      },
    };

    expect(scrubSpan(span).attributes).toEqual({
      "gen_ai.request.model": "claude-haiku-5-5",
      "gen_ai.usage.input_tokens": 120,
      "url.full": "https://mise.example.com/cal/feed.ics",
    });
  });

  test("the SDK collects no personal data and runs without a DSN", () => {
    const options = sentryOptions({} as Env);

    expect(options).toMatchObject({
      dsn: undefined,
      dataCollection: { userInfo: false, cookies: false, httpBodies: [], genAI: { inputs: false, outputs: false } },
    });
  });
});
