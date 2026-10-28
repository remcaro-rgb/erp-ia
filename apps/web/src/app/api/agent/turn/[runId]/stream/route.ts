import { agentStreamResponse, ownsRun } from "@erp/agent";
import { getRun } from "workflow/api";
import { z } from "zod";
import { callerOrResponse } from "@/lib/auth/http";
import { processFailure, processProblem } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";

// GET /api/agent/turn/:runId/stream?startIndex=n   header x-conversation-id   (design §7.1, rules 12 and 17)
// Reconnects the assistant drawer to a turn that is still streaming (AI SDK `WorkflowChatTransport`: a dropped
// response, a function timeout). As the session's user, and only for a run that is a turn of the named conversation,
// which must be theirs in the active company (404 otherwise). `startIndex` counts the UI message chunks the client
// already holds: the run's durable stream is replayed from its start and converted, and that many chunks are skipped
// (raw model parts and UI chunks are not one to one). Negative (tail-relative) indexes are not offered.

const RunId = z.string().regex(/^wrun_[0-9A-Za-z]{1,64}$/);
const StartIndex = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;

  const runId = RunId.safeParse((await params).runId);
  const conversationId = z.uuid().safeParse(request.headers.get("x-conversation-id"));
  const startIndex = StartIndex.safeParse(new URL(request.url).searchParams.get("startIndex") ?? "0");
  if (!runId.success) return processProblem("invalid_input", "run_id");
  if (!conversationId.success) return processProblem("invalid_input", "x-conversation-id");
  if (!startIndex.success) return processProblem("invalid_input", "start_index");

  const { sql } = processDeps();
  try {
    if (!(await ownsRun(sql, caller.claims, conversationId.data, runId.data))) return processProblem("not_found", "run_not_found");
    const readable = getRun(runId.data).getReadable({ startIndex: 0 });
    return agentStreamResponse(readable, { "x-workflow-run-id": runId.data, "x-conversation-id": conversationId.data }, { uiStartIndex: startIndex.data });
  } catch (error) {
    return processFailure(error);
  }
}
