import "server-only";
import { ProcessError, recordTitles, runProcess, withClaims, type Caller, type RecordRef } from "@erp/kernel";
import { relatedModel, type RelatedModel, type RelatedNode } from "@erp/ui";
import { gridEntity } from "@/lib/grid/access";
import { processDeps } from "@/lib/server/runtime";
import { recordEntity } from "./entities";
import { guardRelated } from "./related-guard";

// The tab «Documentos relacionados» of a record page (design §22.27, R31-8): the trail runs through the process pipeline as the caller
// (`kernel.document_link.trail`, the only way the trail is read: masking, the cap and the audit are the process's), each node the caller sees
// is named with the title resolver (the number the kernel never reads, rule 4) and the answer is shaped by the frame's model. A hidden node
// is a count, never a name: nothing but the count is asked about it here.

/** What the page draws: the model, and the label key of each entity named in it (the document kind's name). */
export interface LoadedRelated {
  model: RelatedModel;
  /** Entity id → catalogue key of its name, for the entities of the entries. */
  nouns: Record<string, string>;
}

interface TrailAnswer {
  nodes: { direction: "up" | "down"; depth: number; kind: string | null; entity: string; id: string; voided: boolean }[];
  hidden: number;
  truncated: boolean;
}

const refused = (error: unknown): boolean => error instanceof ProcessError && ["forbidden", "not_entitled", "not_found"].includes(error.code);

/**
 * The related documents of the record, or null when it has none the caller sees or counts (no tab). It never rejects: any failure of the
 * trail or of the title resolver is logged and gives no tab (the record page renders without it).
 */
export const loadRelated = (caller: Caller, entityId: string, recordId: string): Promise<LoadedRelated | null> => guardRelated(() => loadTrail(caller, entityId, recordId));

async function loadTrail(caller: Caller, entityId: string, recordId: string): Promise<LoadedRelated | null> {
  const deps = processDeps();
  let answer: TrailAnswer;
  try {
    answer = (await runProcess(deps, caller, "kernel.document_link.trail", { entity: entityId, id: recordId })) as TrailAnswer;
  } catch (error) {
    // A caller who may not run the trail, or a record the trail does not know, has no tab: the record page itself answers for the rest.
    if (refused(error)) return null;
    throw error;
  }
  const refs: RecordRef[] = [];
  const nouns: Record<string, string> = {};
  for (const node of answer.nodes) {
    const entity = gridEntity(deps.registry, node.entity);
    if (!entity) continue;
    nouns[entity.id] = entity.label;
    refs.push({ entity, id: node.id });
  }
  const titles = refs.length > 0 ? await withClaims(deps.sql, caller.claims, (tx) => recordTitles(tx, deps.registry, refs)) : new Map<string, string | null>();
  const nodes: RelatedNode[] = answer.nodes
    // Rule 21: every entry is a link, so a node whose entity has no record page is not listed (none of today's kinds).
    .filter((node) => recordEntity(node.entity) !== null)
    .map((node) => ({ ...node, label: titles.get(`${node.entity}:${node.id}`) ?? null }));
  const model = relatedModel({ nodes, hidden: answer.hidden, truncated: answer.truncated });
  return model ? { model, nouns } : null;
}
