// Where a record opens (rule 21, design §22.15): the one rule every link to a record follows, in the grids, the forms,
// the audit, the assistant's results and `ui__open_record`, the home. Pure and browser-safe (no React, no database):
// `@erp/kernel/href` for the browser, the registry index for the server.

/** The kernel's entity of the company's users (users/entity.ts): their page is under Administración › Usuarios. */
export const USER_ENTITY = "kernel.user";

/** The page of a record: a user's under /admin/users/<id>, any other record's frame at /r/<entity id>/<record id>. */
export const recordHref = (entity: string, recordId: string): string => (entity === USER_ENTITY ? `/admin/users/${recordId}` : `/r/${entity}/${recordId}`);

/** Whether a record of the entity has a page a link can open: its module declares it (`EntityDef.recordPage`). */
export const hasRecordPage = (entity: { recordPage?: boolean } | null | undefined): boolean => entity?.recordPage === true;

/** The ids of the entities among `entities` whose records have a page. */
export const recordPageEntities = (entities: readonly { id: string; recordPage?: boolean }[]): Set<string> => new Set(entities.filter(hasRecordPage).map((e) => e.id));
