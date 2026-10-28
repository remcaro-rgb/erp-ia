import type { LanguageModelUsage } from "ai";

// The tokens of one model step (rule 27). Imports nothing but AI SDK types: the agent workflow reads its steps' usage
// inside the workflow sandbox.

export interface StepTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** The tokens of one model step (`StepResult`): missing counts are zero; cache reads when the provider reports them. */
export function stepUsage(step: { usage: LanguageModelUsage; model: { modelId: string } }): StepTokens {
  const { usage } = step;
  return {
    model: step.model.modelId,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
}

/** The policy a turn asked for (kernel-free copy of `ModelChoice`). */
interface Policy {
  primary: string;
  fallbacks: string[];
}

/**
 * The model a step is metered under (rule 27): the policy's requested model, unless the response says one of the
 * policy's fallbacks answered (by its gateway id, or by its id without the `provider/` prefix). Any other response id
 * (a dated variant, a provider's internal name, a test double) is the requested model, so it is never billed at a
 * rate that is not the policy's.
 */
export function attributeModel(responseModelId: string | undefined, policy: Policy): string {
  const models = [policy.primary, ...policy.fallbacks];
  if (!responseModelId) return policy.primary;
  if (models.includes(responseModelId)) return responseModelId;
  return models.find((model) => model.slice(model.indexOf("/") + 1) === responseModelId) ?? policy.primary;
}
