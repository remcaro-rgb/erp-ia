import { decideConfirmation } from "@erp/agent";
import { z } from "zod";
import { activeCallerOrResponse } from "@/lib/auth/http";
import { processFailure } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";

// POST /api/agent/confirm  { token | cardId, decision: "confirm" | "reject", stepUpToken? }  →  { status, result?, reason? }
// (design §6 "Agent", rules 15 and 17). The session's user decides a confirmation card the assistant proposed in one of
// their conversations, named by the token the tool returned or by the card's id (what a stored conversation keeps;
// only the card's own user may use it): confirm runs the process as them with origin `agent` (once, however often the card is
// confirmed), reject discards it. Refusals answer with the process codes: 404 for a card that is not theirs, 401
// `step_up_required` when the process needs the step-up code (from /api/auth/step-up), 400 for an expired card. An
// inactive membership (design §22.16) is refused first (403 `forbidden`, `details.reason` membership_inactive), also a reject.

const Body = z
  .object({
    token: z.string().min(32).max(200).optional(),
    cardId: z.uuid().optional(),
    decision: z.enum(["confirm", "reject"]),
    stepUpToken: z.string().min(1).max(200).optional(),
  })
  .refine((body) => (body.token === undefined) !== (body.cardId === undefined), { message: "token_or_card_id" });

export async function POST(request: Request): Promise<Response> {
  const caller = await activeCallerOrResponse();
  if (caller instanceof Response) return caller;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ code: "invalid_input", details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  const { token, cardId, decision, stepUpToken } = parsed.data;
  try {
    return Response.json(await decideConfirmation(processDeps(), caller, cardId !== undefined ? { cardId } : token!, decision, stepUpToken));
  } catch (error) {
    return processFailure(error);
  }
}
