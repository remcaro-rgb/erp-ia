"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import type { SavedGridState, SavedViewItem } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";

// Saved views of a grid (design §9, rule 20), as the session's user through kernel.saved_view.* (audited). Each
// action answers the user's views of the entity after the change, so the grid's menu shows them at once.

export type ViewsResult = { ok: true; views: SavedViewItem[] } | { ok: false; code: string };

async function run(entity: string, change: (caller: Awaited<ReturnType<typeof requireCaller>>) => Promise<unknown>): Promise<ViewsResult> {
  const caller = await requireCaller();
  try {
    await change(caller);
    return { ok: true, views: await runProcess(processDeps(), caller, "kernel.saved_view.list", { entity }) };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code };
    throw error;
  }
}

export async function saveViewAction(entity: string, name: string, isDefault: boolean, state: SavedGridState): Promise<ViewsResult> {
  return run(entity, (caller) => runProcess(processDeps(), caller, "kernel.saved_view.save", { entity, name, isDefault, state }));
}

export async function deleteViewAction(entity: string, id: string): Promise<ViewsResult> {
  return run(entity, (caller) => runProcess(processDeps(), caller, "kernel.saved_view.delete", { id }));
}
