import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from "@ai-sdk/workflow";
import { createUIMessageStreamResponse, type UIMessageChunk } from "ai";

// The turn's durable stream stores the model's raw stream parts (`ModelCallStreamPart`); the client reads AI SDK UI
// message chunks. The conversion happens at the response boundary, in the route.

export interface StreamOptions {
  /**
   * UI chunks the client already received (a reconnection's `startIndex`): the raw stream is replayed from its start
   * and that many converted chunks are skipped. Raw parts and UI chunks are not one to one, so a UI index is never
   * used as the raw stream's own start index (`createModelCallToUIChunkTransform`).
   */
  uiStartIndex?: number;
}

/** The run's stream as UI message chunks (with the start / finish chunks the client expects). */
export function toUIMessageStream(readable: ReadableStream<ModelCallStreamPart>, options: StreamOptions = {}): ReadableStream<UIMessageChunk> {
  return readable.pipeThrough(createModelCallToUIChunkTransform({ uiStartIndex: options.uiStartIndex ?? 0 }));
}

/** The streaming response of a turn: server-sent UI message chunks, with extra headers (the run id). */
export function agentStreamResponse(readable: ReadableStream<ModelCallStreamPart>, headers: Record<string, string> = {}, options: StreamOptions = {}): Response {
  return createUIMessageStreamResponse({ stream: toUIMessageStream(readable, options), headers });
}
