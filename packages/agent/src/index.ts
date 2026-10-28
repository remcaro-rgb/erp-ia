// The assistant runtime (design §7.1, §7.4): registry-generated tools, the durable turn, confirmation cards, the model
// policy and usage limits.

export const AGENT_VERSION = "0.1.0";

export { BUILTIN_TOOLS } from "./tools/builtin";
export { capResult, MAX_RESULT_BYTES, MAX_RESULT_ROWS, scrubTokens } from "./tools/cap";
export { buildTools, toolDescriptors, toolSet } from "./tools/build";
export type { ToolDescriptor, ToolRefusal, ToolRunner } from "./tools/descriptor";
export { executeTool } from "./tools/execute";
export { EXCLUDED_PROCESSES, inputJsonSchema, permittedProcesses, processIdOfTool, toolName } from "./tools/from-registry";
export { CONFIRMATION_TTL_MINUTES, createConfirmation, decideConfirmation } from "./runtime/confirm";
export type { CardRef, ConfirmationRequired, Decision, DecisionResult } from "./runtime/confirm";
export { createConversation, ownsConversation, ownsRun } from "./runtime/conversation";
export { PolicyEmbedder } from "./runtime/embedder";
export { AI_TOKENS_LIMIT_KEY, checkTokenBudget, costUsd, MODEL_PRICES, overBudget } from "./runtime/limits";
export type { TokenBudget } from "./runtime/limits";
export { MissingModelPolicy, resolveModel } from "./runtime/model-policy";
export type { AgentTask, ModelChoice } from "./runtime/model-policy";
export { PolicyModel, policyModel, setAgentModelFactory } from "./runtime/policy-model";
export type { ModelFactory } from "./runtime/policy-model";
export { agentModelFactory, mockAgentModel } from "./runtime/mock-agent-model";
export { HISTORY_VIEW_ROWS, loadConversationView, uiMessagesFromRows } from "./runtime/history";
export type { CardView, ConversationView, StoredMessageRow } from "./runtime/history";
export { buildPreview } from "./runtime/preview";
export type { ConfirmationPreview } from "./runtime/preview";
export { agentStreamResponse, toUIMessageStream } from "./runtime/stream";
export type { StreamOptions } from "./runtime/stream";
export { buildSystemPrompt } from "./runtime/system-prompt";
export type { PromptFacts, ScreenContext } from "./runtime/system-prompt";
export { agentTurn, MAX_STEPS } from "./runtime/turn.workflow";
export type { TurnArgs } from "./runtime/turn.workflow";
export { recordUsage, stepUsage } from "./runtime/usage";
