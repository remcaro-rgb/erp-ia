import { ProcessError, runProcess, type Caller } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { recordEntity, type RecordEntity } from "./entities";

// Server-side loading of one record for the full-page frame. Every read is a consult process run as the
// session's user, so company RLS, the party scope, field masking and roles_view apply exactly as in the grid.

export interface LoadedRecord {
  entity: RecordEntity;
  caller: Caller;
  record: Record<string, unknown> & { id: string };
  defs: Awaited<ReturnType<typeof customFields>>;
  contacts: Awaited<ReturnType<typeof contacts>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const customFields = (caller: Caller, entity: string) => runProcess(processDeps(), caller, "kernel.custom_field.list", { entity });
const contacts = (caller: Caller, partyId: string) => runProcess(processDeps(), caller, "core.contact.list", { partyId });

/** A side panel the caller may not read (no permission) is empty, not a failure of the page. */
async function orEmpty<T>(read: Promise<T[]>): Promise<T[]> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ProcessError && (error.code === "forbidden" || error.code === "not_entitled")) return [];
    throw error;
  }
}

/**
 * The record `/r/<entity>/<id>` shows, or null when the entity has no full page, the id is not a UUID, or the
 * record does not exist for the caller (a hidden record looks like a missing one). Throws `Unauthenticated`
 * without a complete session; the page turns that into a redirect.
 */
export async function loadRecord(entityId: string, id: string): Promise<LoadedRecord | null> {
  const entity = recordEntity(entityId);
  if (!entity || !UUID.test(id)) return null;
  const caller = await requireCaller();
  let record;
  try {
    record = await runProcess(processDeps(), caller, entity.consult, { id });
  } catch (error) {
    if (error instanceof ProcessError && ["not_found", "forbidden", "not_entitled"].includes(error.code)) return null;
    throw error;
  }
  const [defs, partyContacts] = await Promise.all([
    orEmpty(customFields(caller, entity.id)),
    entity.id === "core.party" ? orEmpty(contacts(caller, id)) : Promise.resolve([]),
  ]);
  return { entity, caller, record: record as LoadedRecord["record"], defs, contacts: partyContacts };
}
