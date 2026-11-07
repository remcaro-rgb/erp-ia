import type { JSONSchema7 } from "@ai-sdk/provider";
import { z } from "zod";
import { consultProcessesOf, entitled as resolveEntitled, runnableProcesses, type Caller, type ProcessDef, type Registry, type RunProcessDeps } from "@erp/kernel";
import type { ToolDescriptor } from "./descriptor";

// The process tools (design §5.4 "the agent's tool list is generated from the registry", rules 1 and 17): one tool per
// registered process the caller may run in the active company and the company is entitled to. A module the company
// does not have, or a process no role of the caller holds, simply has no tool.

/** `core.party.create` → `core__party__create`: tool names allow only `[a-zA-Z0-9_-]`. */
export const toolName = (processId: string): string => processId.replaceAll(".", "__");

/** `core__party__create` → `core.party.create`. */
export const processIdOfTool = (name: string): string => name.replaceAll("__", ".");

/**
 * Registered processes never offered in a chat, with the reason. Each needs something only its screen provides: an
 * uploaded file, a background job that the screen's route starts after the process committed (a chat run would
 * leave the job queued forever), or the sign-out and notice that follow the removal of a second-step factor.
 */
export const EXCLUDED_PROCESSES: ReadonlyMap<string, string> = new Map([
  ["kernel.export.run", "creates a queued export job that only the export route starts; the chat cannot hand over the file"],
  ["kernel.import.run", "needs the uploaded file, which the import route stores and then starts the import workflow"],
  ["kernel.import.preview", "validates an uploaded file the chat does not have"],
  ["kernel.attachment.add", "records a file already stored by the attachments route; the chat uploads none"],
  ["kernel.user.mfa.disable", "removing the caller's factor must end their session with the sign-in notice; the user menu handles the sign-out and the notice, the chat cannot"],
  ["kernel.user.password.change", "a password must never travel through the chat; the user menu's dialog changes it"],
  ["kernel.admin.user.password.reset", "a password must never travel through the chat; the user page's dialog resets it"],
  ["kernel.admin.user.mfa.set", "removing a factor must be followed by the sign-out and the notice; the user page handles them (the admin's own factor included), the chat cannot"],
  // Rule 17 (plan 2B Task 25): a consult the assistant gets reads masked views only. This one reads invoicing's published, unmasked
  // invoicing.v_receivable_invoices (number, dates, totals and balances whatever the role's field modes on invoicing.invoice say); the
  // assistant finds a customer's invoices through kernel.data.query over the masked invoicing.invoice, and payments.payment.receive checks
  // each allocation itself.
  ["payments.payment.open_invoices", "reads invoicing's unmasked published view of the invoices; the assistant reads them through the masked invoicing.invoice entity"],
  // Plan 2B Task 32 (R32-10): the assistant gains nothing from configurable nested runs. It neither widens what a nested run may do nor
  // retries or dismisses a queued failure (a replayed write chosen from a queue the chat does not show).
  ["kernel.admin.nested_run.pair.set", "changes which nested runs a parent's step-up covers and which may continue after a failure; only the admin screen sets it"],
  ["kernel.admin.nested_run.depth.set", "changes how deep nested runs may go; only the admin screen sets it"],
  ["kernel.nested_failure.retry", "replays a queued nested write chosen on the failure queue screen; the chat does not see the queue"],
  ["kernel.nested_failure.dismiss", "closes a queued nested failure chosen on the failure queue screen; the chat does not see the queue"],
  // Plan 2B Task 33 (R33-5): the posting mode decides whether a documento may exist without its entry; the assistant cannot change that guarantee.
  ["accounting.posting_mode.set", "changes whether documents post inline and strict or asynchronously; only the Mapeo de cuentas screen sets it, under step-up"],
]);

/**
 * Whether the assistant may ever be offered `def`, whoever asks (rules 1 and 17): not a process restricted to other origins (an event
 * consumer's, a screen's: `origins` without `agent`), not one that runs only nested in another (`nestedOnlyFrom`), not an excluded one.
 */
export const isAgentTool = (def: ProcessDef): boolean => (!def.origins || def.origins.includes("agent")) && !def.nestedOnlyFrom && !EXCLUDED_PROCESSES.has(def.id);

/** The registry's processes the assistant may ever be offered (`isAgentTool`), in registry order; the caller's roles and company narrow them. */
export const agentCandidates = (registry: Registry): ProcessDef[] => registry.processes().filter(isAgentTool);

/**
 * The process's input as a plain JSON Schema object (draft 7, no `$schema` marker): what the model fills in. A part
 * Zod cannot express (a custom check) becomes an open schema; `runProcess` validates the real input with Zod anyway.
 */
export function inputJsonSchema(schema: z.ZodType): JSONSchema7 {
  const json = z.toJSONSchema(schema, { io: "input", target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json as JSONSchema7;
}

/** The descriptor of a process tool. */
export function processToolDescriptor(def: ProcessDef): ToolDescriptor {
  return {
    name: toolName(def.id),
    description: def.description,
    inputSchema: inputJsonSchema(def.input),
    source: { type: "process", processId: def.id, kind: def.kind },
  };
}

/**
 * The processes of `registry` the caller may run and the company is entitled to (the same two checks `runProcess`
 * makes before anything else: entitlement, then the role matrix), among the candidates (`agentCandidates`). Kernel processes are the
 * platform's and always entitled, as in `runProcess`.
 */
export async function permittedProcesses(deps: RunProcessDeps, caller: Caller, registry: Registry): Promise<ProcessDef[]> {
  const candidates = agentCandidates(registry);
  const runnable = await runnableProcesses(deps.sql, registry, caller.claims, candidates.map((p) => p.id));
  const entitled = deps.entitled ?? resolveEntitled;
  const allowed = await Promise.all(
    candidates.map(async (p) => runnable.has(p.id) && (p.module === "kernel" || (await entitled(deps.sql, caller.claims.active_company_id, `process:${p.id}`)))),
  );
  return candidates.filter((_, i) => allowed[i]);
}

/** The data query process, whose tool names the entities the caller may read with it. */
export const DATA_QUERY_PROCESS = "kernel.data.query";

/**
 * One descriptor per permitted process, in registry order. The data query's tool lists the entities whose own
 * consult process is among `permitted` (entitled and allowed to a role of the caller), in its description and as the
 * enum of its `entity` field, so the model never guesses one.
 */
export function describeProcesses(registry: Registry, permitted: readonly ProcessDef[]): ToolDescriptor[] {
  const allowed = new Set(permitted.map((p) => p.id));
  return permitted.map((def) => {
    const descriptor = processToolDescriptor(def);
    if (def.id !== DATA_QUERY_PROCESS) return descriptor;
    const entities = registry
      .entities()
      .filter((entity) => consultProcessesOf(registry, entity).some((id) => allowed.has(id)))
      .map((entity) => entity.id);
    const schema = descriptor.inputSchema as { properties?: Record<string, Record<string, unknown>> };
    if (schema.properties?.entity && entities.length > 0) schema.properties.entity = { ...schema.properties.entity, enum: entities };
    return { ...descriptor, description: `${descriptor.description}. Entidades que puedes consultar: ${entities.length > 0 ? entities.join(", ") : "ninguna"}` };
  });
}

/** One descriptor per permitted process, in registry order (see `describeProcesses`). */
export async function processToolDescriptors(deps: RunProcessDeps, caller: Caller, registry: Registry): Promise<ToolDescriptor[]> {
  return describeProcesses(registry, await permittedProcesses(deps, caller, registry));
}
