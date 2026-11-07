import { z } from "zod";
import type { Tx } from "../db/client";
import { ProcessError } from "../process/errors";
import type { Registry } from "../registry";

// The document links (design §22.27, plan 2B Task 31): a business flow across user actions is followed through links between documents
// (quote → order → delivery → invoice → receipt, many to many), never through a copied id. A registered create or update process writes
// the links into the document its module owns, in its own transaction, through ctx.links; the definer functions of migration 0124
// refuse anything but the running process naming itself (rule 1), a `to` document of another module, and an end that does not exist in
// the caller's company. The chain of each link is the run's (`erp.audit_chain_id`, set by runProcess). Read through the consult
// kernel.document_link.trail (trail.process.ts); users read no raw row.

/** The kind of a link, declared by the writing module: `<from>_to_<to>` in lowercase words (`quote_to_order`). */
export const LINK_KIND = /^[a-z]+_to_[a-z]+$/;
/** How many documents one sync may name. */
export const LINKS_FROM_MAX = 200;
/**
 * The status of a documento whose links a sync may remove: the only one the lifecycle deletes (D1, design §22.23, `nextStatus` in
 * typed/lifecycle.ts). kernel.document_link_sync tests the same literal; links.test.ts ties the two.
 */
export const BORRADOR_STATUS = "draft";

export const linkEnd = z.object({ entity: z.string().min(1).max(100), id: z.uuid() }).strict();
export type LinkEnd = z.infer<typeof linkEnd>;
export const linksSyncInput = z
  .object({ to: linkEnd, kind: z.string().regex(LINK_KIND), from: z.array(linkEnd).max(LINKS_FROM_MAX) })
  .strict();
export type LinksSync = z.input<typeof linksSyncInput>;
export const linksVoidInput = linkEnd.extend({ reason: z.string().max(500).optional() }).strict();
export type LinksVoid = z.input<typeof linksVoidInput>;

/** ctx.links: present on every runProcess context (nested ones get their own, under their own process). */
export interface LinksApi {
  /**
   * Makes the `kind` links into `to` equal `from`: inserts the missing ones (the same call twice changes nothing and burns no `seq`) and,
   * only while `to` is a Borrador, removes the extra ones that are not marked voided. Call it next to the document's insert and line
   * writes, and with `from: []` before deleting a Borrador. Writes in the run's transaction under the running process (a dry run rolls
   * it back). `to` must be a document of the running process's module; every end must exist in the caller's company.
   */
  sync(input: LinksSync): Promise<{ inserted: number; removed: number }>;
  /** Marks every link of the document, upstream and downstream, as voided by this action (kept, never deleted); answers how many. */
  markVoided(input: LinksVoid): Promise<{ marked: number }>;
}

function invalid(message: string, details?: unknown[]): never {
  throw new ProcessError("invalid_input", message, { details: details ?? [message] });
}

function moduleOf(registry: Registry, entity: string): string {
  try {
    return registry.entity(entity).module;
  } catch {
    return invalid(`document link names an unregistered entity: ${entity}`);
  }
}

/**
 * The ctx.links of the run of `processId`, in its transaction. Refuses (`forbidden`) from a process that is not a create or an update
 * and for a `to` (or voided) document of another module, and (`invalid_input`) an input that does not parse, an entity the registry
 * does not know and a document linked to itself, before any SQL; the definer functions refuse again in SQL.
 */
export function makeLinks(tx: Tx, registry: Registry, processId: string): LinksApi {
  /**
   * The one gate before SQL: a create or update process (forbidden otherwise, checked first), then the module that owns `entity`. A delete
   * process (Eliminar of a Borrador) passes only with `unlink`: sync with `from: []` on its own document, never an insert or a void.
   */
  const writer = (unlink = false) => {
    const def = registry.process(processId);
    if (def.kind !== "create" && def.kind !== "update" && !(unlink && def.kind === "delete")) {
      throw new ProcessError("forbidden", `${processId} is a ${def.kind} process: it may not write document links${def.kind === "delete" ? " (a delete process may only unlink: sync with from [])" : ""}`);
    }
    return (entity: string) => {
      const owner = moduleOf(registry, entity);
      if (owner !== def.module) throw new ProcessError("forbidden", `${processId} may not write the document links of ${entity}: module ${owner} owns it`);
    };
  };
  return {
    async sync(raw) {
      const unlink = typeof raw === "object" && raw !== null && Array.isArray((raw as { from?: unknown }).from) && (raw as { from: unknown[] }).from.length === 0;
      const owns = writer(unlink);
      const parsed = linksSyncInput.safeParse(raw);
      if (!parsed.success) invalid(`invalid document links from ${processId}`, parsed.error.issues);
      const input = parsed.data;
      owns(input.to.entity);
      for (const from of input.from) {
        moduleOf(registry, from.entity);
        if (from.entity === input.to.entity && from.id === input.to.id) invalid(`document link: ${from.entity} ${from.id} is linked to itself`);
      }
      const [row] = await tx<{ inserted: number; removed: number }[]>`
        select inserted, removed from kernel.document_link_sync(${processId}, ${input.to.entity}, ${input.to.id}::uuid, ${input.kind}, ${tx.json(input.from as never)}::jsonb)`;
      return { inserted: row!.inserted, removed: row!.removed };
    },
    async markVoided(raw) {
      const owns = writer();
      const parsed = linksVoidInput.safeParse(raw);
      if (!parsed.success) invalid(`invalid document link void from ${processId}`, parsed.error.issues);
      const input = parsed.data;
      owns(input.entity);
      const [row] = await tx<{ marked: number }[]>`
        select kernel.document_link_mark_voided(${processId}, ${input.entity}, ${input.id}::uuid, ${input.reason ?? null}) as marked`;
      return { marked: row!.marked };
    },
  };
}
