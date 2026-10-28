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
