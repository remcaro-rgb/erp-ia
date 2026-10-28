import type { ModelMessage } from "ai";
import { getServiceDb, registry, type Caller } from "@erp/kernel";
import { builtinToolDescriptors } from "../tools/builtin";
import type { ToolDescriptor } from "../tools/descriptor";
import { executeTool } from "../tools/execute";
import { permittedProcesses, processToolDescriptor } from "../tools/from-registry";
import { appendMessage, loadHistory, ownsConversation } from "./conversation";
import { checkTokenBudget } from "./limits";
import { resolveModel, type ModelChoice } from "./model-policy";
import { catalogueOf, message } from "./preview";
import { scrubTokens } from "../tools/cap";
import { attributeModel, type StepTokens } from "./step-usage";
import { buildSystemPrompt, loadPromptFacts, sanitizeScreen, type ScreenContext } from "./system-prompt";
import { recordUsage } from "./usage";

// What the steps of the turn workflow do (turn.workflow.ts). Kept apart from the workflow file and free of top-level
// effects: the workflow sandbox bundle drops this module (step bodies are replaced there), so the kernel, the database
// client and Node built-ins never reach the sandbox; the steps run it with full Node access.

export interface TurnArgs {
  conversationId: string;
  caller: Caller;
  userText: string;
  screen?: ScreenContext;
}

export type Prepared =
  | { kind: "not_found" }
  | { kind: "over_budget"; message: string }
  | { kind: "ready"; model: ModelChoice; system: string; tools: ToolDescriptor[]; messages: ModelMessage[] };

/** The caller as their tools act: origin `agent`, in this conversation. */
const toolCaller = (args: TurnArgs): Caller => ({ ...args.caller, origin: "agent", conversationId: args.conversationId });

const deps = () => ({ sql: getServiceDb(), registry });

/**
 * Checks and stores the user's message, then gathers what the model needs. Nothing is stored for a conversation that
 * is not the caller's in their active company. Over the token allowance, the turn stops before any model call.
 */
export async function prepare(args: TurnArgs, runId: string): Promise<Prepared> {
  // A worker without the app's modules cannot resolve a process: fail the step (it is retried) rather than the turn.
  if (registry.modules().length === 0) throw new Error("agent: no modules loaded in worker");
  const { sql } = deps();
  const { claims } = args.caller;
  if (!(await ownsConversation(sql, claims, args.conversationId))) return { kind: "not_found" };

  await appendMessage(sql, {
    companyId: claims.active_company_id,
    conversationId: args.conversationId,
    role: "user",
    parts: [{ type: "text", text: args.userText }],
    runId,
    userId: claims.sub,
  });

  const budget = await checkTokenBudget(sql, claims.active_company_id);
  if (!budget.allowed) {
    return { kind: "over_budget", message: message(catalogueOf(claims.locale), "errors.ai_budget_exceeded") ?? "errors.ai_budget_exceeded" };
  }

  const caller = toolCaller(args);
  const model = await resolveModel(sql, claims.tenant_id, "chat");
  // The caller's tools: the processes they may run in an entitled company, then the built-ins (rule 17).
  const permitted = await permittedProcesses(deps(), caller, registry);
  const tools = [...permitted.map(processToolDescriptor), ...(await builtinToolDescriptors(deps(), caller, registry))];
  // Only a screen of the app and a registered record reach the prompt (the browser sent them).
  const screen = sanitizeScreen(registry, args.screen);
  const facts = await loadPromptFacts(sql, caller, { userText: args.userText, screen, permitted, conversationId: args.conversationId, runId });
  const history = await loadHistory(sql, args.conversationId, runId);
  return { kind: "ready", model, system: buildSystemPrompt(facts), tools, messages: [...history, { role: "user", content: args.userText }] };
}

/** One tool call of the turn, as the caller with origin `agent` (a consult runs; a write becomes a confirmation card). */
export function runTool(args: TurnArgs, name: string, input: unknown): Promise<unknown> {
  return executeTool(deps(), toolCaller(args), name, input);
}

/** Stores an answer given without the model (over the token allowance). */
export async function storeReply(args: TurnArgs, runId: string, text: string): Promise<void> {
  const { claims } = args.caller;
  await appendMessage(getServiceDb(), {
    companyId: claims.active_company_id,
    conversationId: args.conversationId,
    role: "assistant",
    parts: [{ role: "assistant", content: [{ type: "text", text }] }],
    runId,
    userId: claims.sub,
  });
}

/**
 * Meters one model call of the turn, as it ends (rule 27): under the policy's model (or the fallback that answered),
 * priced at the requested model's rate when the table lacks the answering one. Keyed by run and step: written once.
 */
export async function meterStep(args: TurnArgs, runId: string, stepNumber: number, tokens: StepTokens, policy: ModelChoice): Promise<void> {
  const { claims } = args.caller;
  await recordUsage(getServiceDb(), {
    companyId: claims.active_company_id,
    userId: claims.sub,
    conversationId: args.conversationId,
    task: "chat",
    model: attributeModel(tokens.model, policy),
    priceAs: policy.primary,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cachedTokens: tokens.cachedTokens,
    runId,
    stepNumber,
  });
}

/**
 * Stores the turn's answer: its response messages without any confirmation token (the card id stays), followed by
 * the failure message when the turn ended with an error (also when it produced nothing).
 */
export async function finish(args: TurnArgs, runId: string, response: ModelMessage[], error?: string): Promise<void> {
  const sql = getServiceDb();
  const { claims } = args.caller;
  if (error) console.error(`agent turn ${runId} ended with an error: ${error}`);
  const failed = { role: "assistant", content: [{ type: "text", text: message(catalogueOf(claims.locale), "agent.failed") ?? "" }] };
  const parts: unknown[] = [...scrubTokens(response), ...(error || response.length === 0 ? [failed] : [])];
  await appendMessage(sql, { companyId: claims.active_company_id, conversationId: args.conversationId, role: "assistant", parts, runId, userId: claims.sub });
}
