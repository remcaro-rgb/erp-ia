import type { AdminMember } from "@/lib/admin/load";

// What the "Editar" dialog of a user (design §22.16) edits and what it sends to kernel.admin.user.update: only the data
// the admin changed (the process refuses an empty change), the mobile always with its country code, the roles as a set.

/** The languages a user can pick (the application's catalogues), with the i18n key of each name. */
export const USER_LOCALES = [
  { value: "es-419", label: "common.admin.users.locale_es_419" },
  { value: "en", label: "common.admin.users.locale_en" },
] as const;

/** The i18n key of a locale's name, or null for a value the application has no catalogue for. */
export const localeLabel = (locale: string): string | null => USER_LOCALES.find((l) => l.value === locale)?.label ?? null;

export interface UserDraft {
  name: string;
  mobileCc: string;
  mobile: string;
  locale: string;
  /** A data URL, or null for no picture. */
  photo: string | null;
  roleIds: string[];
}

/** The dialog's starting values: the member as stored. */
export const draftOf = (member: AdminMember): UserDraft => ({
  name: member.name,
  mobileCc: member.mobileCc ?? "57",
  mobile: member.mobile ?? "",
  locale: member.locale,
  photo: member.photo,
  roleIds: [...member.roleIds],
});

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;

/** The input of kernel.admin.user.update for what changed, or null when nothing did. */
export function userChanges(member: AdminMember, draft: UserDraft): Record<string, unknown> | null {
  const start = draftOf(member);
  const changes: Record<string, unknown> = {};
  const name = draft.name.trim();
  if (name !== start.name.trim()) changes.name = name;
  if (draft.mobileCc !== start.mobileCc || draft.mobile !== start.mobile) Object.assign(changes, { mobileCc: draft.mobileCc, mobile: draft.mobile });
  if (draft.locale !== start.locale) changes.locale = draft.locale;
  if (!sameSet(draft.roleIds, start.roleIds)) changes.roleIds = draft.roleIds;
  if (draft.photo !== start.photo) changes.photo = draft.photo;
  return Object.keys(changes).length === 0 ? null : { userId: member.userId, ...changes };
}
