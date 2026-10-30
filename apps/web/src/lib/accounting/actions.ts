"use server";

import { gridDenial, gridEntity } from "@/lib/grid/access";
import { ProcessError, runProcess } from "@erp/kernel";
import type { MasterTree } from "@erp/module-accounting";
import { requireCaller } from "@/lib/auth/claims";
import { signOutIfDisabled } from "@/lib/auth/disabled";
import { processDeps } from "@/lib/server/runtime";
import { loadMasterTree } from "./load";
import { createInputFor, masterPage, masterViewKey, type MasterView, type NodeInput } from "./masters";

// The actions of the master page (accounting design §8), as the session's user: the tree of a period, the remembered Tabla · Árbol
// choice and the creation of a node through the entity's create process (rule 1).

export type TreeResult = { ok: true; tree: MasterTree } | { ok: false; code: string };

export async function loadMasterTreeAction(entity: string, periodId: string | null): Promise<TreeResult> {
  if (!masterPage(entity)) return { ok: false, code: "not_found" };
  const caller = await requireCaller();
  const deps = processDeps();
  const resolved = gridEntity(deps.registry, entity);
  if (!resolved) return { ok: false, code: "not_found" };
  // The tree is a grid's data: the same entitlement and consult permission.
  const denial = await gridDenial(deps, caller.claims, resolved);
  if (denial) return { ok: false, code: denial };
  return { ok: true, tree: await loadMasterTree(caller, entity, periodId) };
}

export async function saveMasterViewAction(entity: string, view: MasterView): Promise<{ ok: boolean }> {
  if (!masterPage(entity) || (view !== "table" && view !== "tree")) return { ok: false };
  const caller = await requireCaller();
  try {
    await runProcess(processDeps(), caller, "kernel.user_prefs.set", { key: masterViewKey(entity), value: view });
    return { ok: true };
  } catch (error) {
    // A choice that could not be saved only costs the next visit its starting view.
    if (error instanceof ProcessError) return { ok: false };
    throw error;
  }
}

export type CreateNodeResult = { ok: true; id: string } | { ok: false; code: string; details: string[] };

export async function createMasterNodeAction(entity: string, input: NodeInput): Promise<CreateNodeResult> {
  const master = masterPage(entity);
  if (!master) return { ok: false, code: "not_found", details: [] };
  const caller = await requireCaller();
  try {
    const { id } = (await runProcess(processDeps(), caller, master.create, createInputFor(entity, input))) as { id: string };
    return { ok: true, id };
  } catch (error) {
    await signOutIfDisabled(error);
    if (error instanceof ProcessError) return { ok: false, code: error.code, details: Array.isArray(error.details) ? error.details.map(String) : [] };
    throw error;
  }
}
