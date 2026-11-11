"use server";

import { ProcessError, runProcess } from "@erp/kernel";
import type { SaveResult } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";
import { issuesOf } from "./issues";
import { stepRefusal } from "./step-refusal";

// Saving a mapping tab a module contributed to a record page (rule 1): the process the manifest names, run as the
// session's user with the step-up token when the user just verified one. The browser sends only the roles and the chosen
// records; which process runs, and the dimension it maps, come from the manifest and the record id, never from the client.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MappingPick {
  role: string;
  /** The chosen record, or null to clear the role's mapping. */
  accountId: string | null;
}

/** Saves the roles of contribution `tabId` for record `recordId` of `entityId` as `{ mappings: [{ role, dimension, accountId }] }`. */
export async function saveMappingAction(entityId: string, tabId: string, recordId: string, picks: readonly MappingPick[], stepUpToken?: string): Promise<SaveResult> {
  const registry = processDeps().registry;
  const tab = registry.recordTabsFor(entityId).find((c) => c.id === tabId);
  const invalid: SaveResult = { ok: false, code: "invalid_input", details: [] };
  if (!tab || tab.kind !== "mapping" || !UUID.test(recordId) || !Array.isArray(picks)) return invalid;
  const roles = new Set(tab.roles);
  if (picks.some((p) => !roles.has(p.role) || (p.accountId !== null && !UUID.test(String(p.accountId))))) return invalid;

  const caller = { ...(await requireCaller()), ...(stepUpToken ? { stepUpToken } : {}) };
  const dimension = tab.dimension!.replaceAll("{id}", recordId);
  try {
    await runProcess(processDeps(), caller, tab.saveProcess!, { mappings: picks.map((p) => ({ role: p.role, dimension, accountId: p.accountId })) });
    return { ok: true, id: recordId };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: issuesOf(error.details) };
    throw error;
  }
}

/** What the button of a grid contribution answers: done (with the reason the process gave when it made nothing), or the refusal. */
export type ContributedActionOutcome = { ok: true; reason: string | null } | { ok: false; code: string; messages: string[] };

/**
 * Runs the button of grid contribution `tabId` on record `recordId` of `entityId` (plan 2B.2 Task 29.4, RG-9: «Crear alistamiento» on a
 * pedido). The process and its input key come from the manifest; the browser sends only which tab and which record.
 */
export async function runContributedAction(entityId: string, tabId: string, recordId: string): Promise<ContributedActionOutcome> {
  const tab = processDeps().registry.recordTabsFor(entityId).find((c) => c.id === tabId);
  if (!tab || tab.kind !== "grid" || !tab.action || !UUID.test(recordId)) return { ok: false, code: "invalid_input", messages: [] };
  const caller = await requireCaller();
  try {
    const out = (await runProcess(processDeps(), caller, tab.action.process, { [tab.action.inputField]: recordId })) as { created?: unknown; reason?: unknown } | null;
    // A create that made nothing says why (an open alistamiento already, nothing left to deliver): the tab tells it.
    return { ok: true, reason: out && out.created === false && typeof out.reason === "string" ? out.reason : null };
  } catch (error) {
    return stepRefusal(error);
  }
}
