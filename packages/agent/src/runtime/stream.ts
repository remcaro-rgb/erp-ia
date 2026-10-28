import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";

// The turn's durable stream stores the model's raw stream parts (`ModelCallStreamPart`); the client reads AI SDK UI
// message chunks. The conversion happens at the response boundary, in the route.

/** The run's stream as UI message chunks (with the start / finish chunks the client expects). */
export function toUIMessageStream(readable: ReadableStream<ModelCallStreamPart>): ReadableStream<UIMessageChunk> {
  return readable.pipeThrough(createModelCallToUIChunkTransform());
}

/** The streaming response of a turn: server-sent UI message chunks, with extra headers (the run id). */
export function agentStreamResponse(readable: ReadableStream<ModelCallStreamPart>, headers: Record<string, string> = {}): Response {
  return createUIMessageStreamResponse({ stream: toUIMessageStream(readable), headers });
}
