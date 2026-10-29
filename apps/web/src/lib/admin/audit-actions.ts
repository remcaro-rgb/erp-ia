"use server";

import { auditEntityOf, ProcessError, recordPageEntities, recordTitles, runProcess, withClaims, type AuditEntryDetail, type RecordRef } from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps, registrySynced } from "@/lib/server/runtime";
import { auditLabels } from "./audit-labels";
import { presentAuditDetail, type AuditDetailView } from "./audit-view";

// The audit viewer's reads beyond its grid (design §22.13–14, rule 16): one entry's detail through kernel.audit.entry (the
// company admin's, audited as a consult, under the viewer's field visibility), and the titles of the records the grid's
// Registro and Origen columns link to (rule 21), read as the caller through each entity's masked view.

export type AuditEntryResult = { ok: true; view: AuditDetailView } | { ok: false; code: string };

export async function auditEntryAction(id: string): Promise<AuditEntryResult> {
  const caller = await requireCaller();
  await registrySynced();
  try {
    const detail = (await runProcess(processDeps(), caller, "kernel.audit.entry", { id })) as AuditEntryDetail;
    return { ok: true, view: presentAuditDetail(detail, await auditLabels(), recordPageEntities(processDeps().registry.entities())) };
  } catch (error) {
    if (error instanceof ProcessError) return { ok: false, code: error.code };
    throw error;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A grid page has at most 500 rows, each naming its record and its source. */
const MAX_REFS = 1000;

/** Record id → title, for the records named `{ entity, id }` (as an audit entry spells the entity) the caller sees. */
export async function auditTitlesAction(refs: { entity: string; id: string }[]): Promise<Record<string, string>> {
  const caller = await requireCaller();
  const { sql, registry } = processDeps();
  const resolved: RecordRef[] = [];
  for (const ref of Array.isArray(refs) ? refs.slice(0, MAX_REFS) : []) {
    if (typeof ref?.entity !== "string" || typeof ref.id !== "string" || !UUID.test(ref.id)) continue;
    const entity = auditEntityOf(registry, ref.entity);
    if (entity) resolved.push({ entity, id: ref.id });
  }
  if (resolved.length === 0) return {};
  const titles = await withClaims(sql, caller.claims, (tx) => recordTitles(tx, registry, resolved));
  const out: Record<string, string> = {};
  for (const [key, title] of titles) if (title !== null) out[key.slice(key.lastIndexOf(":") + 1)] = title;
  return out;
}
