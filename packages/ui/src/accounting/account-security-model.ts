// Security by account (accounting design §4.15, §5.13): the Seguridad tab of a Cuenta. Pure rules, so the tab stays thin and the
// rules are unit-tested. Only the company admin reads or edits permissions, and every change is the one step-up process.

export type SubjectKind = "role" | "user";
export type Access = "open" | "restricted";

export interface Grant {
  subjectKind: SubjectKind;
  subjectId: string;
  /** The role's or user's name as the consult answers it (null when it was deleted). */
  subjectName: string | null;
  canView: boolean;
  canPost: boolean;
}

export interface SecurityDraft {
  access: Access;
  grants: readonly Grant[];
}

/** A role or user that can be given a grant. */
export interface Subject {
  kind: SubjectKind;
  id: string;
  name: string;
}

export type SecurityChange = "add" | "remove" | "toggle" | "access";

export const SECURITY_PROCESS = "accounting.account_permission.update";

/** Every change of access or grants runs `account_permission.update`, a step-up process (design §6): the save asks for the code. */
export function stepUpFor(change: SecurityChange): { process: string; stepUp: true } {
  void change;
  return { process: SECURITY_PROCESS, stepUp: true };
}

/** The tab exists only for the caller who could read the account's permissions (the admin); `null` is a refusal. */
export function securityTabVisible(consulted: { access: string } | null | undefined): boolean {
  return consulted !== null && consulted !== undefined;
}

const same = (g: Grant, kind: SubjectKind, id: string) => g.subjectKind === kind && g.subjectId === id;

/** Changes `ver` or `contabilizar` of one grant: contabilizar implies ver, and no ver means no contabilizar. */
export function setGrant(grants: readonly Grant[], kind: SubjectKind, id: string, patch: { canView?: boolean; canPost?: boolean }): Grant[] {
  return grants.map((g) => {
    if (!same(g, kind, id)) return g;
    const canPost = patch.canPost ?? (patch.canView === false ? false : g.canPost);
    const canView = patch.canView ?? g.canView;
    return { ...g, canPost, canView: canView || canPost };
  });
}

/** Agregar: a new subject starts with `ver`; a subject already in the grid stays as it is. */
export function addGrant(grants: readonly Grant[], subject: Subject): Grant[] {
  if (grants.some((g) => same(g, subject.kind, subject.id))) return [...grants];
  return [...grants, { subjectKind: subject.kind, subjectId: subject.id, subjectName: subject.name, canView: true, canPost: false }];
}

/** Quitar. */
export function removeGrant(grants: readonly Grant[], kind: SubjectKind, id: string): Grant[] {
  return grants.filter((g) => !same(g, kind, id));
}

/** The input of `accounting.account_permission.update`. */
export function securityInput(accountId: string, draft: SecurityDraft) {
  return {
    accountId,
    access: draft.access,
    grants: draft.grants.map((g) => ({ subjectKind: g.subjectKind, subjectId: g.subjectId, canView: g.canView || g.canPost, canPost: g.canPost })),
  };
}

/** Whether the draft differs from what is stored. */
export function securityChanged(stored: SecurityDraft, draft: SecurityDraft): boolean {
  const key = (g: Grant) => `${g.subjectKind}|${g.subjectId}|${g.canView}|${g.canPost}`;
  const a = stored.grants.map(key).sort().join(",");
  const b = draft.grants.map(key).sort().join(",");
  return stored.access !== draft.access || a !== b;
}
