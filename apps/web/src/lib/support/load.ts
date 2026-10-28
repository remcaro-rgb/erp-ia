import "server-only";
import { runnableProcesses } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { loadGridPage, type GridPageData } from "@/lib/grid/load";
import { processDeps } from "@/lib/server/runtime";

// What the support screen needs besides its grid (design §8): which of the ticket processes the caller may run.
// "Nuevo ticket" needs create; the conversation's reply box needs reply; an agent (who may close tickets) also
// writes internal notes and closes.

export const TICKET_ENTITY = "support.ticket";
export const TICKET_CREATE = "support.ticket.create";
export const TICKET_REPLY = "support.ticket.reply";
export const TICKET_CLOSE = "support.ticket.close";

export interface SupportPageData {
  grid: GridPageData;
  canCreate: boolean;
}

export type SupportPageResult = { ok: true; data: SupportPageData } | { ok: false; denial: Extract<Awaited<ReturnType<typeof loadGridPage>>, { ok: false }>["denial"] };

export async function loadSupportPage(): Promise<SupportPageResult> {
  const caller = await requireCaller();
  const deps = processDeps();
  const grid = await loadGridPage(TICKET_ENTITY, "/support");
  if (!grid.ok) return grid;
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, [TICKET_CREATE]);
  return { ok: true, data: { grid: grid.data, canCreate: runnable.has(TICKET_CREATE) } };
}
