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
 * uploaded file, or a background job that the screen's route starts after the process committed (a chat run would
 * leave the job queued forever).
 */
export const EXCLUDED_PROCESSES: ReadonlyMap<string, string> = new Map([
  ["kernel.export.run", "creates a queued export job that only the export route starts; the chat cannot hand over the file"],
  ["kernel.import.run", "needs the uploaded file, which the import route stores and then starts the import workflow"],
  ["kernel.import.preview", "validates an uploaded file the chat does not have"],
  ["kernel.attachment.add", "records a file already stored by the attachments route; the chat uploads none"],
]);

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
 * makes before anything else: entitlement, then the role matrix), minus the excluded ones. Kernel processes are the
 * platform's and always entitled, as in `runProcess`.
 */
export async function permittedProcesses(deps: RunProcessDeps, caller: Caller, registry: Registry): Promise<ProcessDef[]> {
  const candidates = registry.processes().filter((p) => !EXCLUDED_PROCESSES.has(p.id));
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
