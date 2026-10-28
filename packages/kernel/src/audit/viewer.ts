import { z } from "zod";
import { requireAdmin } from "../admin/common";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { QueryError } from "../query/errors";
import { GridFilter, GridSort, GridState } from "../query/grid-state";
import { gridQueryInTx } from "../query/run";
import { defineEntity } from "../registry/entities";

// The audit viewer (design §5.9: "the audit viewer is itself a consult process with its own permission", §6, rule 16).
// `kernel.audit` is the registry entity of the company's audit log as its admin reads it, through `kernel.v_audit_entries`
// (migration 0023: the company admin only, without the recorded input and diff). The /admin/audit grid, its exports and
// the assistant read it through the same gate: the company admin role holds `kernel.audit.consult` (the role defaults
// give every registered process to the system admin role and no kernel consult to other roles).

export const AUDIT_FEATURE = "kernel.audit";

/** Where an audited action came from (`kernel.audit_log.origin`). */
export const AUDIT_ORIGINS = ["ui", "agent", "scheduler", "event", "api", "db"] as const;
/** What it did (`kernel.audit_log.action`; `denied` is a refused run). */
export const AUDIT_ACTIONS = ["insert", "update", "delete", "consult", "denied"] as const;

export const auditEntity = defineEntity({
  id: "kernel.audit",
  module: "kernel",
  schema: "kernel",
  table: "audit_entries",
  label: "entity.kernel.audit",
  displayField: "process_id",
  defaultSort: { field: "occurred_at", dir: "desc" },
  fields: [
    { name: "occurred_at", type: "datetime", label: "field.kernel.audit.occurred_at" },
    { name: "origin", type: "enum", label: "field.kernel.audit.origin", enumValues: [...AUDIT_ORIGINS] },
    { name: "process_id", type: "text", label: "field.kernel.audit.process_id" },
    { name: "entity", type: "text", label: "field.kernel.audit.entity" },
    { name: "row_id", type: "uuid", label: "field.kernel.audit.row_id" },
    { name: "action", type: "enum", label: "field.kernel.audit.action", enumValues: [...AUDIT_ACTIONS] },
    { name: "actor", type: "text", label: "field.kernel.audit.actor" },
    { name: "chain_id", type: "uuid", label: "field.kernel.audit.chain_id" },
    { name: "actor_user_id", type: "uuid", label: "field.kernel.audit.actor_user_id" },
    { name: "conversation_id", type: "uuid", label: "field.kernel.audit.conversation_id" },
  ],
});

/** Entries per page at most: a consult answers a page, the grid's export reads every page itself. */
export const AUDIT_PAGE_MAX = 100;

export const auditConsult = defineProcess({
  id: "kernel.audit.consult",
  module: "kernel",
  kind: "consult",
  feature: AUDIT_FEATURE,
  description:
    "Consulta la auditoría de la empresa (solo el administrador): quién hizo qué y cuándo, desde dónde (interfaz, asistente, programador, eventos, API o base de datos), en qué proceso y registro, y con qué cadena causal; con filtros, orden y página",
  input: z.object({
    filters: z.array(GridFilter).max(50).default([]),
    sort: z.array(GridSort).max(5).default([]),
    page: z.number().int().min(1).default(1),
    pageSize: z.number().int().min(1).max(AUDIT_PAGE_MAX).default(50),
  }),
  // One row per entry with the entity's fields (`occurred_at`, `origin`, `process_id`, `entity`, `row_id`, `action`,
  // `actor`, `chain_id`, `actor_user_id`, `conversation_id`) and its `id`.
  output: z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(AUDIT_PAGE_MAX), total: z.number(), page: z.number() }),
  handler: async (ctx, input) => {
    // The role matrix lets the process run; administering the company is what may read its whole log.
    await requireAdmin(ctx);
    const state = GridState.parse({ filters: input.filters, sort: input.sort.length > 0 ? input.sort : [auditEntity.defaultSort], page: input.page, pageSize: input.pageSize });
    try {
      const { rows, total } = await gridQueryInTx(ctx.tx, auditEntity, state);
      return { rows, total, page: input.page };
    } catch (error) {
      if (error instanceof QueryError) throw new ProcessError("invalid_input", error.message, { details: { reason: error.code, field: error.field } });
      throw error;
    }
  },
});

export const AUDIT_PROCESSES = [auditConsult];
