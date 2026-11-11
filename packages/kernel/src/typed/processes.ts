import { z } from "zod";
import { defineProcess } from "../process/define";
import type { EntityDef } from "../registry/entities";
import type { ProcessDef } from "../registry/types";
import type { LifecycleAction } from "./lifecycle";
import { runLifecycle } from "./runner";

// The generic processes of every maestro and documento (entity types spec 2026-11-02 §5): `<entity>.save` (Grabar),
// `.submit` (Enviar a aprobación), `.approve` (Aprobar), `.reject` (No Aprobar), `.void` (Anular) and `.delete` (Eliminar).
// The module loader registers them for each typed entity of a module, in the module and in the feature that lists the entity,
// so they are permissioned per process and per role like any other (rule 13): Aprobar needs `<entity>.approve`, No Aprobar
// `<entity>.reject`. The creator or the last editor may approve (owner 2026-11-02: no four-eyes). `<entity>.create` stays the
// module's own process. A module that declares one of these ids itself keeps its own.

export const GENERIC_VERBS = ["save", "submit", "approve", "reject", "void", "delete"] as const satisfies readonly LifecycleAction[];
export type GenericVerb = (typeof GENERIC_VERBS)[number];

const id = z.uuid();
const expectedUpdatedAt = z.iso.datetime({ offset: true }).optional();
const reason = z.string().trim().min(1, "Indica el motivo").max(1000);

const INPUTS = {
  save: z.object({ id, data: z.record(z.string(), z.unknown()).optional(), expectedUpdatedAt }),
  submit: z.object({ id, expectedUpdatedAt }),
  approve: z.object({ id, expectedUpdatedAt }),
  reject: z.object({ id, reason, expectedUpdatedAt }),
  void: z.object({ id, reason, expectedUpdatedAt }),
  delete: z.object({ id, expectedUpdatedAt }),
} as const;

const STATUS = z.enum(["draft", "saved", "pending", "rejected", "approved", "posted", "voided"]);
const output = z.object({ id: z.string(), status: STATUS, number: z.string().optional(), updatedAt: z.string().optional(), deleted: z.literal(true).optional() });

/** Spanish (es-419) tool descriptions; the entity is named by its id (labels are i18n keys the kernel does not translate). */
const DESCRIPTIONS: Record<GenericVerb, (entity: string) => string> = {
  save: (e) => `Graba un registro de ${e}: guarda sus datos y lo pasa de Borrador a Grabado (o lo deja en su estado si ya estaba grabado)`,
  submit: (e) => `Envía a aprobación un registro grabado de ${e} que requiere aprobación (queda Pendiente de Aprobación)`,
  approve: (e) => `Aprueba un registro de ${e} que está Pendiente de Aprobación`,
  reject: (e) => `No aprueba un registro de ${e} que está Pendiente de Aprobación, con el motivo; vuelve a poder editarse`,
  void: (e) => `Anula un documento de ${e} con el motivo; un documento anulado no cambia más`,
  delete: (e) => `Elimina un registro de ${e}: un documento solo en Borrador; un maestro se elimina si nada lo usa (si no, márcalo como Activo = no)`,
};

/** The generic process of `verb` for the maestro or documento `entity`. */
export function genericProcess(entity: Pick<EntityDef, "id" | "module" | "entityType">, verb: GenericVerb): ProcessDef {
  const input = INPUTS[verb];
  return defineProcess({
    id: `${entity.id}.${verb}`,
    module: entity.module,
    kind: verb === "delete" ? "delete" : "update",
    description: DESCRIPTIONS[verb](entity.id),
    input,
    output,
    handler: async (ctx, raw) => {
      const parsed = raw as { id: string; data?: Record<string, unknown>; reason?: string; expectedUpdatedAt?: string };
      const result = await runLifecycle(ctx, ctx.registry.entity(entity.id), parsed.id, verb, {
        data: parsed.data,
        reason: parsed.reason,
        expectedUpdatedAt: parsed.expectedUpdatedAt,
      });
      return { id: parsed.id, ...result };
    },
  }) as unknown as ProcessDef;
}

/** Whether `entity` carries the lifecycle (a maestro or documento table entity). */
export const isTypedEntity = (entity: Pick<EntityDef, "entityType" | "kind">): boolean =>
  entity.kind !== "query" && (entity.entityType === "maestro" || entity.entityType === "documento");

/** The six generic processes of a maestro or documento. */
export const genericProcesses = (entity: Pick<EntityDef, "id" | "module" | "entityType">): ProcessDef[] => GENERIC_VERBS.map((verb) => genericProcess(entity, verb));
