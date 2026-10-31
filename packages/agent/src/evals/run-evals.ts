import { randomUUID } from "node:crypto";
import { isStepCount, streamText, type LanguageModel } from "ai";
import type { Sql } from "postgres";
import type { Caller, Registry, RunProcessDeps } from "@erp/kernel";
import { isMockAgentModelInstalled, MOCK_AGENT_MODEL } from "../runtime/mock-agent-model";
import { resolveModel } from "../runtime/model-policy";
import { policyModel } from "../runtime/policy-model";
import { buildSystemPrompt, loadPromptFacts } from "../runtime/system-prompt";
import { recordUsage } from "../runtime/usage";
import { toolDescriptors } from "../tools/build";
import type { ToolDescriptor } from "../tools/descriptor";
import { permittedProcesses } from "../tools/from-registry";
import { toolSet } from "../tools/tool-set";
import { matchCall, type EvalCall, type EvalCase, type EvalTier } from "./match";

// The model-backed evaluation run (rule 30, design §7.1, owner 2026-10-30): each Spanish prompt of the set goes to the
// policy's chat model with the tools of the calling user and the real system prompt, for one step, and the tool call it
// makes is compared with the case. No tool ever executes (the recorder answers), so nothing is written to the company's
// data; the only writes are the usage rows of the calls (rule 27).

/** Pass rule: every core case, and this share of all cases (owner 2026-10-30). */
export const EVAL_PASS_RATE = 0.9;

export interface EvalResult {
  id: string;
  tier: EvalTier;
  pass: boolean;
  got: EvalCall | null;
  why?: string;
}

export interface EvalReport {
  model: string;
  cases: EvalResult[];
  passRate: number;
  /** Every `core` case passed. */
  corePass: boolean;
}

/** Whether the run meets the owner's rule: every core case and `EVAL_PASS_RATE` overall. */
export const evalsPassed = (report: EvalReport): boolean => report.corePass && report.passRate >= EVAL_PASS_RATE;

export function buildReport(model: string, cases: EvalResult[]): EvalReport {
  return {
    model,
    cases,
    passRate: cases.length === 0 ? 0 : cases.filter((c) => c.pass).length / cases.length,
    corePass: cases.every((c) => c.tier !== "core" || c.pass),
  };
}

export interface EvalTokens {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface EvalRun {
  model: LanguageModel;
  system: string;
  descriptors: readonly ToolDescriptor[];
  cases: readonly EvalCase[];
  /** Called after each model call with the case's index and its tokens (the metering). */
  onUsage: (index: number, tokens: EvalTokens) => Promise<void>;
}

/**
 * Runs the cases one after the other, one model step each. The tools are the descriptors with a recorder in place of
 * execution: this function holds no connection and no deps, so a tool call cannot reach a process. A model error
 * fails its case (with the error as the reason) and the run goes on.
 */
export async function runEvalCases(run: EvalRun): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const [index, c] of run.cases.entries()) {
    const recorded: EvalCall[] = [];
    let failure: string | undefined;
    const tools = toolSet(run.descriptors, async (name, input) => {
      recorded.push({ tool: name, input });
      return { ok: true, recorded: true };
    });
    try {
      const result = streamText({
        model: run.model,
        instructions: run.system,
        prompt: c.prompt,
        tools,
        toolChoice: "auto",
        stopWhen: isStepCount(1),
        onError: ({ error }) => void (failure = error instanceof Error ? error.message : String(error)),
      });
      await result.consumeStream();
      const usage = await result.usage;
      await run.onUsage(index, {
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
      });
      const calls = (await result.toolCalls).map((call) => ({ tool: call.toolName, input: call.input }));
      recorded.splice(0, recorded.length, ...calls);
    } catch (error) {
      failure ??= error instanceof Error ? error.message : String(error);
    }
    const wanted = recorded.find((call) => matchCall(c.expect, call) === null) ?? recorded[0];
    if (failure !== undefined && !wanted) {
      results.push({ id: c.id, tier: c.tier, pass: false, got: null, why: `model error: ${failure}` });
    } else if (!wanted) {
      results.push({ id: c.id, tier: c.tier, pass: false, got: null, why: "no tool call (the model answered with text)" });
    } else {
      const why = matchCall(c.expect, wanted);
      results.push({ id: c.id, tier: c.tier, pass: why === null, got: wanted, ...(why ? { why } : {}) });
    }
  }
  return results;
}

/**
 * Runs `cases` as `caller`: the chat model from `kernel.model_policies` (rule 26; `MissingModelPolicy` when there is
 * none), the caller's tools and the system prompt of a real turn, every call metered under the caller (rule 27). With
 * the mock model installed (`AGENT_MODEL=mock`) the run and its metering are the mock's, at no cost.
 */
export async function runEvals(opts: { sql: Sql; deps: RunProcessDeps; caller: Caller; registry: Registry; cases: EvalCase[] }): Promise<EvalReport> {
  const { sql, caller, registry } = opts;
  const { claims } = caller;
  const asAgent: Caller = { ...caller, origin: "agent" };
  const deps = { ...opts.deps, sql, registry };
  const choice = await resolveModel(sql, claims.tenant_id, "chat");
  const permitted = await permittedProcesses(deps, asAgent, registry);
  const descriptors = await toolDescriptors(deps, asAgent, registry);
  const facts = await loadPromptFacts(sql, asAgent, { userText: "", permitted, skipHelp: true });
  const metered = isMockAgentModelInstalled() ? MOCK_AGENT_MODEL : choice.primary;
  const runId = randomUUID();
  const results = await runEvalCases({
    model: policyModel(choice),
    system: buildSystemPrompt(facts),
    descriptors,
    cases: opts.cases,
    onUsage: (index, tokens) =>
      recordUsage(sql, {
        companyId: claims.active_company_id,
        userId: claims.sub,
        task: "chat",
        model: metered,
        ...(metered === choice.primary ? {} : { priceAs: choice.primary }),
        ...tokens,
        runId,
        stepNumber: index,
      }),
  });
  return buildReport(metered, results);
}
