import { loadConversationView } from "@erp/agent";
import { z } from "zod";
import { activeCallerOrResponse } from "@/lib/auth/http";
import { processFailure, processProblem } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";

// GET /api/agent/conversation[?id=<uuid>]  →  { conversationId, messages, cards }
// (design §7.1, rules 12 and 17). The drawer's way to come back to a conversation after a reload: the session's user's
// own conversation in the active company (the one named, else their latest) as UI messages, with the state of every
// confirmation card (pending ones stay confirmable by card id; the card tokens never leave the server). A user with no
// conversation yet gets `{ conversationId: null, messages: [], cards: {} }`; a conversation that is not theirs is a 404.
// An inactive membership (design §22.16) is refused first: 403 `forbidden`, `details.reason` membership_inactive.

const Query = z.object({ id: z.uuid().optional() });

export async function GET(request: Request): Promise<Response> {
  const caller = await activeCallerOrResponse();
  if (caller instanceof Response) return caller;
  const parsed = Query.safeParse({ id: new URL(request.url).searchParams.get("id") ?? undefined });
  if (!parsed.success) return Response.json({ code: "invalid_input", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  try {
    const view = await loadConversationView(processDeps().sql, caller.claims, parsed.data.id);
    if (view) return Response.json(view);
    if (parsed.data.id) return processProblem("not_found", "conversation_not_found");
    return Response.json({ conversationId: null, messages: [], cards: {} });
  } catch (error) {
    return processFailure(error);
  }
}
