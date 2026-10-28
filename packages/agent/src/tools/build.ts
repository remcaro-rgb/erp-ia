import type { ToolSet } from "ai";
import type { Caller, Registry, RunProcessDeps } from "@erp/kernel";
import { builtinToolDescriptors } from "./builtin";
import type { ToolDescriptor } from "./descriptor";
import { executeTool } from "./execute";
import { processToolDescriptors } from "./from-registry";
import { toolSet } from "./tool-set";

export { toolSet } from "./tool-set";

// The caller's tools (design §7.1). The agent workflow lists the descriptors in its preparation step and builds the
// AI SDK tools from them with a runner that executes each call as a workflow step; `buildTools` builds them for a
// caller directly, executing in-process (tests, and any caller outside a workflow).

/** Every tool the caller gets: the registry's processes they may run, then the built-ins. */
export async function toolDescriptors(deps: RunProcessDeps, caller: Caller, registry: Registry): Promise<ToolDescriptor[]> {
  return [...(await processToolDescriptors(deps, caller, registry)), ...(await builtinToolDescriptors(deps, caller, registry))];
}

/**
 * The tools of `caller` (whose `conversationId` is where write proposals are stored), executing in-process: consults
 * run `runProcess` as the caller with origin `agent`, writes return a confirmation card.
 */
export async function buildTools(deps: RunProcessDeps, caller: Caller, opts: { registry: Registry }): Promise<ToolSet> {
  const scoped = { ...deps, registry: opts.registry };
  return toolSet(await toolDescriptors(scoped, caller, opts.registry), (name, input) => executeTool(scoped, caller, name, input));
}
