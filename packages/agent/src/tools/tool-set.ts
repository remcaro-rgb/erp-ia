import { jsonSchema, tool, type ToolSet } from "ai";
import type { ToolDescriptor, ToolRunner } from "./descriptor";

// From tool descriptors to the AI SDK's tools (design §7.1). Imports nothing but the AI SDK: the agent workflow builds
// its tools with it inside the workflow sandbox, where the kernel (database, Node modules) is never loaded.

/** One AI SDK tool per descriptor; executing a call hands its name and input to `run`. */
export function toolSet(descriptors: readonly ToolDescriptor[], run: ToolRunner): ToolSet {
  const tools: ToolSet = {};
  for (const descriptor of descriptors) {
    tools[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: jsonSchema(descriptor.inputSchema),
      execute: (input: unknown) => run(descriptor.name, input),
    });
  }
  return tools;
}
