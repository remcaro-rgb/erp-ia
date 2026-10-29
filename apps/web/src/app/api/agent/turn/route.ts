import { agentStreamResponse, agentTurn, createConversation, ownsConversation } from "@erp/agent";
import { start } from "workflow/api";
import { z } from "zod";
import { activeCallerOrResponse } from "@/lib/auth/http";
import { processFailure, processProblem } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";

// POST /api/agent/turn  { conversationId?, text, screen? }  →  the turn's stream of AI SDK UI message chunks
// (design §7.1, rules 12 and 17). As the session's user: a new conversation is created when none is named; a named
// one must be theirs in the active company (404 otherwise). The turn runs as the `agentTurn` workflow with the
// caller's claims as its argument; the response streams the run and carries `x-workflow-run-id` (to reconnect) and
// `x-conversation-id`. Refusals carry codes (`errors.<code>`, details such as `conversation_not_found`) the client
// translates; the route holds no copy (rule 24). A session whose membership in the active company is inactive (design
// §22.16) is refused first (403 `forbidden`, `details.reason` membership_inactive): no conversation, message or run.

/** A question and its screen context are a few kilobytes at most. */
const MAX_BODY_BYTES = 32 * 1024;

const Body = z.object({
  conversationId: z.uuid().optional(),
  text: z.string().trim().min(1).max(4000),
  screen: z
    .object({
      route: z.string().max(300).optional(),
      record: z.object({ entity: z.string().min(1).max(100), id: z.uuid() }).optional(),
    })
    .optional(),
});

export async function POST(request: Request): Promise<Response> {
  const caller = await activeCallerOrResponse();
  if (caller instanceof Response) return caller;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return processProblem("invalid_input", "message_too_long");
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "invalid_input", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const { text, screen } = parsed.data;

  const { sql } = processDeps();
  try {
    let conversationId = parsed.data.conversationId;
    if (conversationId === undefined) conversationId = await createConversation(sql, caller.claims, text);
    else if (!(await ownsConversation(sql, caller.claims, conversationId))) return processProblem("not_found", "conversation_not_found");

    const run = await start(agentTurn, [{ conversationId, caller: { claims: caller.claims, origin: "ui" }, userText: text, ...(screen ? { screen } : {}) }]);
    return agentStreamResponse(run.readable, { "x-workflow-run-id": run.runId, "x-conversation-id": conversationId });
  } catch (error) {
    return processFailure(error);
  }
}
