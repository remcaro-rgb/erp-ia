import { ProcessError, runProcess, type Caller, type ProcessDef, type RunProcessDeps } from "@erp/kernel";
import { createConfirmation, scrubRefusal } from "../runtime/confirm";
import { isBuiltin, runBuiltin } from "./builtin";
import { capResult } from "./cap";
import { refusal } from "./descriptor";
import { permittedProcesses, processIdOfTool } from "./from-registry";

// One tool call, as the caller (rule 17). A consult runs its process through `runProcess` with origin `agent` and the
// conversation, so it is entitlement-, permission- and step-up-checked, masked and audited like any other run. A
// create, update or delete never runs here: it becomes a confirmation card. A refusal of the pipeline comes back as the
// tool's result (the model explains it to the user), scrubbed of the handler's text; anything else is thrown, and the workflow step retries it.

/** The caller as the assistant acts for them: origin `agent`, in the conversation. */
export const agentCaller = (caller: Caller): Caller => ({ ...caller, origin: "agent" });

function processOf(deps: RunProcessDeps, name: string): ProcessDef | undefined {
  try {
    return deps.registry.process(processIdOfTool(name));
  } catch {
    return undefined;
  }
}

export async function executeTool(deps: RunProcessDeps, caller: Caller, name: string, input: unknown): Promise<unknown> {
  const asAgent = agentCaller(caller);
  if (isBuiltin(name)) return runBuiltin(deps, name, input);
  const def = processOf(deps, name);
  if (!def) return refusal("not_found", { message: `unknown tool ${name}` });
  try {
    // A consult's answer is capped before the model reads it (rule 17).
    if (def.kind === "consult") return capResult(await runProcess(deps, asAgent, def.id, input));
    // A card only for a process the caller may run now: the tool list was made at the start of the turn.
    const permitted = await permittedProcesses(deps, asAgent, deps.registry);
    if (!permitted.some((p) => p.id === def.id)) return refusal("forbidden");
    return await createConfirmation(deps, asAgent, def, input);
  } catch (error) {
    // Its code and a catalogue text, as a card's dry run (scrubRefusal): a handler's text may hold what the caller's masks hide.
    if (error instanceof ProcessError) return scrubRefusal(error, { locale: caller.claims.locale, processId: def.id });
    throw error;
  }
}
