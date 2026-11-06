import { type AssistantMessage, createModels, fauxProvider } from "@earendil-works/pi-ai";
import { inject } from "vitest";
import { type AgentModels, claudeAgentModels, useAgentModels } from "../src/agent";

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
