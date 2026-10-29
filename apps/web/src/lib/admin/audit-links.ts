import { hasRecordPage, recordHref, USER_ENTITY } from "@erp/kernel/href";

// Where the audit viewer's references lead (rule 21, design §22.15): a record of an entity whose module declares a page for
// it opens where the kernel's `recordHref` says (its frame at /r/<entity>/<id>), an actor at their user page under
// Administración › Usuarios.
// Pure and browser-safe (no kernel import): the grid's cells and the detail sheet share it.

/** The kernel's system user (event consumers run as it): shown as "sistema", with no user page. */
export const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";

/** The page of a record of `entity`, or null when the entity has none (a platform table) or there is no record. */
export function auditRecordHref(entity: { id: string; recordPage?: boolean } | null | undefined, id: string | null | undefined): string | null {
  if (!entity || !id) return null;
  return hasRecordPage(entity) ? recordHref(entity.id, id) : null;
}

/** The user page of an actor; null for the system and for no actor. */
export function actorHref(userId: string | null | undefined): string | null {
  return userId && userId !== SYSTEM_ACTOR ? recordHref(USER_ENTITY, userId) : null;
}

/** The names the audit grid shows instead of raw ids (design §22.14), built by the page's loader. */
export interface AuditCatalogue {
  /** Process id → its description (Spanish, the registry's). */
  processes: Record<string, string>;
  /** How an entry spells an entity (`core.party`, `core.parties`, `core.category`) → the registered entity and its name. */
  entities: Record<string, { id: string; label: string; recordPage: boolean }>;
  /** User id → name, for the company's members. */
  members: Record<string, string>;
}
