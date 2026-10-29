"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";

// The home screen's one write: the user's decision on a recommendation (`kernel.recommendation.decide`, audited). An
// accepted suggested action comes back for the screen to hand to the assistant, which asks for the confirmation card.

export interface DecideResult {
  status: "accepted" | "dismissed";
  open?: { processId: string; input: Record<string, unknown> };
  href?: string;
}

export type DecideOutcome = { ok: true; result: DecideResult } | { ok: false; code: ProcessError["code"] };

export async function decideRecommendationAction(input: { id: string; decision: "accepted" | "dismissed"; action?: number }): Promise<DecideOutcome> {
  const caller = await requireCaller();
  try {
    const out = (await runProcess(processDeps(), caller, "kernel.recommendation.decide", input)) as DecideResult;
    return { ok: true, result: { status: out.status, ...(out.open ? { open: out.open } : {}), ...(out.href ? { href: out.href } : {}) } };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code };
    throw error;
  }
}
