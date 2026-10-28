import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test";

// A scripted AI SDK mock model (`MockLanguageModelV4`, the AI SDK 7 successor of MockLanguageModelV2) for the turn
// tests: the n-th call of a turn (counted by the assistant messages already in the prompt) answers the n-th script
// entry, either a text or a tool call. Every call is recorded with its options (system prompt, tools, messages).

export type Scripted = { text: string } | { tool: string; input: unknown } | { error: string };

export const MOCK_USAGE = {
  inputTokens: { total: 50, noCache: 40, cacheRead: 10, cacheWrite: undefined },
  outputTokens: { total: 12, text: 12, reasoning: undefined },
};

export interface ScriptedModel {
  model: MockLanguageModelV4;
  calls: LanguageModelV4CallOptions[];
}

export function scriptedModel(script: Scripted[], modelId = "mock/model"): ScriptedModel {
  const calls: LanguageModelV4CallOptions[] = [];
  const model = new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doStream: async (options) => {
      calls.push(options);
      // The prompt of this turn starts after the last user message; count the assistant answers since then.
      const lastUser = options.prompt.map((m) => m.role).lastIndexOf("user");
      const index = Math.min(options.prompt.slice(lastUser + 1).filter((m) => m.role === "assistant").length, script.length - 1);
      const entry = script[index]!;
      if ("error" in entry) throw new Error(entry.error);
      const head = [
        { type: "stream-start" as const, warnings: [] },
        { type: "response-metadata" as const, id: `r${index}`, modelId, timestamp: new Date(0) },
      ];
      const body =
        "text" in entry
          ? [
              { type: "text-start" as const, id: "t" },
              { type: "text-delta" as const, id: "t", delta: entry.text },
              { type: "text-end" as const, id: "t" },
              { type: "finish" as const, finishReason: { unified: "stop" as const, raw: "stop" }, usage: MOCK_USAGE },
            ]
          : [
              { type: "tool-call" as const, toolCallId: `call-${index}`, toolName: entry.tool, input: JSON.stringify(entry.input) },
              { type: "finish" as const, finishReason: { unified: "tool-calls" as const, raw: undefined }, usage: MOCK_USAGE },
            ];
      return { stream: convertArrayToReadableStream([...head, ...body]) };
    },
  });
  return { model, calls };
}

/** The system prompt the model received on a call. */
export function systemOf(call: LanguageModelV4CallOptions): string {
  return call.prompt
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join("\n");
}
