import { allowedActions, canEditData, type LifecycleAction, type LifecycleFlags, type RecordStatus } from "@erp/kernel/lifecycle";

// The state buttons of the record action bar (entity types spec §5, design §10 D15, approved prototype `barSpec`): derived from the
// kernel's transition table, intersected with the caller's rights. `post` is never a button (D8: posting is automatic, in the same
// action as Guardar or Aprobar). With approval required, an editable record before approval offers «Guardar» and «Guardar y enviar a
// aprobación» (save + submit, one action); «Enviar a aprobación» alone only on a saved record (Grabado). No pure UI rule here widens
// what the server allows: every button runs a registered process that checks again (hiding is never the only guard).

export type { LifecycleAction, LifecycleFlags, RecordStatus } from "@erp/kernel/lifecycle";

export type EntityKind = "maestro" | "documento";

/** A state button of the bar. `save_submit` is «Guardar y enviar a aprobación»: Guardar then Enviar, one user action. */
export type BarAction = "save" | "save_submit" | "submit" | "approve" | "reject" | "void" | "delete";

/** Everything the bar can ask of its page. */
export type RecordBarAction = BarAction | "new" | "print" | "notify" | "duplicate" | "reverse";

/** What the caller may do on this record: process permissions ∩ record access ∩ menu access, computed by the page's server. */
export interface RecordRights {
  /** Guardar / Enviar a aprobación (the save and submit processes, record access `modify`). */
  modify: boolean;
  /** Enviar a aprobación (the submit process); defaults to `modify`. */
  submit?: boolean;
  /** Eliminar (the delete process, record access `delete`). */
  delete: boolean;
  /** Anular (the void process, record access `void`). */
  void: boolean;
  /** Aprobar (the approve process). The creator or the last editor may approve (owner rule). */
  approve: boolean;
  /** No aprobar (the reject process); defaults to `approve`. */
  reject?: boolean;
}

export interface BarButton {
  action: BarAction;
  /** The highlighted button of the bar. */
  primary?: boolean;
  tone?: "ok" | "danger";
  /** A state change of the stored record: disabled while the form holds unsaved edits. */
  state?: boolean;
}

/** The state buttons for a record of `type` in `status`, in display order. A new record is `draft`. */
export function barButtons(type: EntityKind, status: RecordStatus, flags: LifecycleFlags, rights: RecordRights): BarButton[] {
  const acts = new Set<LifecycleAction>(allowedActions(type, status, flags));
  const out: BarButton[] = [];
  const preApproval = status === "draft" || status === "saved" || status === "rejected";
  const submit = rights.submit ?? rights.modify;
  if (rights.modify && acts.has("save") && canEditData(type, status)) {
    if (flags.requiresApproval && preApproval && submit) out.push({ action: "save" }, { action: "save_submit", primary: true });
    else out.push({ action: "save", primary: true });
  }
  if (rights.modify && submit && acts.has("submit") && status === "saved") out.push({ action: "submit", state: true });
  if (rights.approve && acts.has("approve")) out.push({ action: "approve", state: true, tone: "ok" });
  if ((rights.reject ?? rights.approve) && acts.has("reject")) out.push({ action: "reject", state: true, tone: "danger" });
  if (rights.void && acts.has("void")) out.push({ action: "void", state: true, tone: "danger" });
  if (rights.delete && acts.has("delete")) out.push({ action: "delete", tone: "danger" });
  return out;
}

/** The note under the bar when the record posts in the same action (no «Contabilizar» button, D8). */
export function postsAutomatically(type: EntityKind, status: RecordStatus, flags: LifecycleFlags): boolean {
  return type === "documento" && flags.posts && (status === "draft" || status === "saved" || status === "rejected" || status === "pending");
}

/** Actions that ask for a reason before they run. */
export const NEEDS_REASON: ReadonlySet<RecordBarAction> = new Set(["reject", "void", "reverse"]);
