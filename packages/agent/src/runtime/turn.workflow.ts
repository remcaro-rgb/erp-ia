import { WorkflowAgent, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { isStepCount, type ModelMessage } from "ai";
import { getWorkflowMetadata, getWritable } from "workflow";
import { toolSet } from "../tools/tool-set";
import { policyModel } from "./policy-model";
import { stepUsage, type StepTokens } from "./step-usage";
import { finish, prepare, runTool, storeReply, type Prepared, type TurnArgs } from "./turn.steps";

export type { TurnArgs } from "./turn.steps";

// One turn of the assistant (design §7.1): a durable workflow per user message, started by POST /api/agent/turn. It
// checks the conversation is the caller's and the company is within its monthly token allowance (rule 27), reads the
// model from the policy table (rule 26), lists the caller's tools (rule 17: only what their roles allow, generated from
// the registry), assembles the Spanish system prompt, and runs the AI SDK's `WorkflowAgent` (the successor of the
// Workflow DevKit's deprecated `DurableAgent`) for at most `MAX_STEPS` model calls, streaming its parts to the run's
// stream. Every tool call is a workflow step that acts as the caller; the turn's messages and one usage row per model
// call are stored at the end. The caller's claims travel as the workflow's arguments; the service connection writes
// only the agent's own bookkeeping rows (conversation, messages, cards, usage).
//
// The sandbox side of this file imports only the AI SDK, the workflow runtime and kernel-free modules; everything that
// touches the database is in turn.steps.ts, called from the steps below.

/** Model calls per turn at most. */
export const MAX_STEPS = 12;

export async function agentTurn(args: TurnArgs): Promise<void> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  const writable = getWritable<ModelCallStreamPart>();
  const prepared = await prepareTurn(args, workflowRunId);
  if (prepared.kind === "not_found") return await closeStream(writable);
  if (prepared.kind === "over_budget") return await replyWithoutModel(args, workflowRunId, prepared.message, writable);

  const agent = new WorkflowAgent({
    model: policyModel(prepared.model),
    instructions: prepared.system,
    tools: toolSet(prepared.tools, (name, input) => runToolStep(args, name, input)),
  });
  const result = await agent.stream({ messages: prepared.messages, writable, stopWhen: isStepCount(MAX_STEPS) });

  // The turn's response: everything after the user's message (assistant text and tool calls, tool results).
  const lastUser = result.messages.map((m) => m.role).lastIndexOf("user");
  const response = result.messages.slice(lastUser + 1);
  const usage = result.steps.map((step) => stepUsage(step));
  await finishTurn(args, workflowRunId, response, usage, result.error === undefined ? undefined : String(result.error));
}

/** Checks the conversation, stores the user's message, checks the allowance and gathers the model's input. */
export async function prepareTurn(args: TurnArgs, runId: string): Promise<Prepared> {
  "use step";
  return prepare(args, runId);
}

/** One tool call, as the caller with origin `agent` (a consult runs; a write becomes a confirmation card). */
export async function runToolStep(args: TurnArgs, name: string, input: unknown): Promise<unknown> {
  "use step";
  return runTool(args, name, input);
}

/** Answers without the model (over the token allowance): the text goes to the stream and to the conversation. */
export async function replyWithoutModel(args: TurnArgs, runId: string, text: string, writable: WritableStream<ModelCallStreamPart>): Promise<void> {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write({ type: "text-start", id: "budget" } as ModelCallStreamPart);
    await writer.write({ type: "text-delta", id: "budget", text } as ModelCallStreamPart);
    await writer.write({ type: "text-end", id: "budget" } as ModelCallStreamPart);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
  await storeReply(args, runId, text);
}

/** Ends the run's stream with nothing in it. */
export async function closeStream(writable: WritableStream<ModelCallStreamPart>): Promise<void> {
  "use step";
  await writable.close();
}

/** Stores the turn's response messages and one usage row per model call. */
export async function finishTurn(args: TurnArgs, runId: string, response: ModelMessage[], usage: StepTokens[], error?: string): Promise<void> {
  "use step";
  await finish(args, runId, response, usage, error);
}
