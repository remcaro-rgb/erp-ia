// Pure lifecycle transition table for typed entities (spec 2026-11-02 §5.1-§5.3, D1-D3, D6, D8, D10).
// No I/O: the lifecycle runner and the record action bar consume it.

export type RecordStatus = "draft" | "saved" | "pending" | "rejected" | "approved" | "posted" | "voided";
export type LifecycleAction = "save" | "submit" | "approve" | "reject" | "void" | "delete" | "post";
export interface LifecycleFlags {
  requiresApproval: boolean;
  posts: boolean;
}
type Target = RecordStatus | "deleted";
type EntityKind = "maestro" | "documento";

/** Actions in display order; allowedActions returns a subsequence of this list. */
const ACTIONS: readonly LifecycleAction[] = ["save", "submit", "approve", "reject", "post", "void", "delete"];

/**
 * Transition map: status -> action -> target, with an optional guard on the flags.
 * Combinations the flags make unreachable (e.g. `pending` without requiresApproval)
 * are not special-cased: the table answers as written.
 */
type Rule = { to: Target; when?: (f: LifecycleFlags) => boolean };
type Table = Partial<Record<RecordStatus, Partial<Record<LifecycleAction, Rule>>>>;

const approval = (f: LifecycleFlags) => f.requiresApproval;
const postsNoApproval = (f: LifecycleFlags) => f.posts && !f.requiresApproval;
const postsAfterApproval = (f: LifecycleFlags) => f.posts && f.requiresApproval;

const DOCUMENTO: Table = {
  draft: { save: { to: "saved" }, delete: { to: "deleted" } }, // D1: Eliminar only in Borrador
  saved: {
    save: { to: "saved" },
    submit: { to: "pending", when: approval },
    post: { to: "posted", when: postsNoApproval },
    void: { to: "voided" },
  },
  pending: { approve: { to: "approved" }, reject: { to: "rejected" }, void: { to: "voided" } },
  rejected: { save: { to: "saved" }, void: { to: "voided" } },
  approved: { post: { to: "posted", when: postsAfterApproval }, void: { to: "voided" } },
  // posted -> voided only through the accounting reversal path (D3): refused here.
  posted: {},
  voided: {},
};

const MAESTRO: Table = {
  draft: { save: { to: "saved" }, delete: { to: "deleted" } },
  saved: { save: { to: "saved" }, submit: { to: "pending", when: approval }, delete: { to: "deleted" } },
  pending: { save: { to: "pending" }, approve: { to: "approved" }, reject: { to: "rejected" }, delete: { to: "deleted" } },
  rejected: { save: { to: "saved" }, delete: { to: "deleted" } },
  // D10: a plain save keeps approved; the runner sends an approval-relevant change back via `submit`.
  approved: { save: { to: "approved" }, submit: { to: "pending", when: approval }, delete: { to: "deleted" } },
  // Maestro has no posted/voided states (D6).
  posted: {},
  voided: {},
};

const TABLES: Record<EntityKind, Table> = { documento: DOCUMENTO, maestro: MAESTRO };

/** Next status for an action, "deleted" for a removal, or null when the action is refused. */
export function nextStatus(
  type: EntityKind,
  from: RecordStatus,
  action: LifecycleAction,
  flags: LifecycleFlags,
): Target | null {
  const rule = TABLES[type][from]?.[action];
  if (!rule) return null;
  if (rule.when && !rule.when(flags)) return null;
  return rule.to;
}

/** Whether data fields may change in this status (D3). Maestro: always. */
export function canEditData(type: EntityKind, status: RecordStatus): boolean {
  if (type === "maestro") return true;
  return status === "draft" || status === "saved" || status === "rejected";
}

/** Actions the status offers; always consistent with nextStatus (each yields non-null). */
export function allowedActions(type: EntityKind, status: RecordStatus, flags: LifecycleFlags): LifecycleAction[] {
  return ACTIONS.filter((a) => nextStatus(type, status, a, flags) !== null);
}

/** Whether a maestro record may be used on documents (spec §5.2). */
export function isUsable(status: RecordStatus, isActive: boolean, flags: Pick<LifecycleFlags, "requiresApproval">): boolean {
  if (!isActive) return false;
  return flags.requiresApproval ? status === "approved" : status === "saved";
}
