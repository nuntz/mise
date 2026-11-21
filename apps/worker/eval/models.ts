import { type AssistantMessage, createModels, fauxProvider } from "@earendil-works/pi-ai";
import { inject } from "vitest";
import { type AgentModels, claudeAgentModels, useAgentModels } from "../src/agent";

/**
 * Refuses to run the eval without an Anthropic key that works: a rejected key otherwise fails every
 * case at its first model call with only `model_error`. Listing one model spends no tokens.
 */
export async function requireWorkingKey(env: Env): Promise<void> {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Put ANTHROPIC_API_KEY in apps/worker/.dev.vars to run the eval.");
  const response = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
  });
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new Error(
    `ANTHROPIC_API_KEY in apps/worker/.dev.vars is rejected (${response.status}): ${body?.error?.message ?? response.statusText}`,
  );
}

/** The real model, not a scripted one: the agent's, or the one `MISE_EVAL_MODEL` asks for. */
export function realModels(env: Env): AgentModels {
  return claudeAgentModels(env.ANTHROPIC_API_KEY, inject("agentModel") || undefined);
}

/**
 * The real model, but the first requests of households started from now on get `responses`, one each,
 * as if it had given them: a history the real model then goes on from. Put back with
 * `useAgentModels(realModels)`.
 */
export function answeredFirst(responses: AssistantMessage[]) {
  useAgentModels((env) => {
    const real = realModels(env);
    const faux = fauxProvider({ models: [{ id: "scripted" }] });
    faux.setResponses(responses);
    const scripted = createModels();
    scripted.setProvider(faux.provider);
    const asking = new Set<PropertyKey>(["stream", "streamSimple", "complete", "completeSimple"]);
    const models = new Proxy(real.models, {
      get(target, key) {
        const answered = faux.getPendingResponseCount() > 0 && asking.has(key);
        const [owner, model] = answered ? [scripted, faux.getModel()] : [target, undefined];
        const value = Reflect.get(owner, key);
        if (typeof value !== "function") return value;
        return model ? (_: unknown, ...rest: unknown[]) => value.call(owner, model, ...rest) : value.bind(owner);
      },
    });
    return { models, model: real.model };
  });
}
