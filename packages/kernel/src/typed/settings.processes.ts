import { z } from "zod";
import { ADMIN_FEATURE, invalid, requireAdmin } from "../admin/common";
import { defineProcess } from "../process/define";
import type { ProcessContext } from "../process/context";
import { validateEmail } from "../validation";
import type { RecordStatus } from "./lifecycle";

// Parámetros of the entity types (spec 2026-11-02 §5.4, §7, §9.2): whether a maestro or documento needs approval, whether a
// documento posts, and who is e-mailed when a record reaches a status. Company-admin only, step-up (rule 15), audited.

const STATUSES = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"] as const satisfies readonly RecordStatus[];
/** Maestro has no posted / voided states (D6). */
const MAESTRO_STATUSES: readonly RecordStatus[] = ["draft", "saved", "pending", "rejected", "approved"];

/** The entity's type when it is a registered maestro or documento, else `invalid_input`. */
function typedKind(ctx: ProcessContext, entityId: string): "maestro" | "documento" {
  const entity = ctx.registry.entities().find((e) => e.id === entityId);
  if (!entity) throw invalid(`unknown entity ${entityId}`, `La entidad ${entityId} no existe`);
  if (entity.entityType !== "maestro" && entity.entityType !== "documento") {
    throw invalid(`entity ${entityId} is ${entity.entityType}`, `La entidad ${entityId} no es un maestro ni un documento`);
  }
  return entity.entityType;
}

export const entityTypeSettingsUpdate = defineProcess({
  id: "kernel.entity_type_settings.update",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Define si los registros de un maestro o documento requieren aprobación y si el documento contabiliza; no cambia los registros existentes",
  input: z.object({ entity: z.string().min(1), requiresApproval: z.boolean(), posts: z.boolean() }),
  output: z.object({ entity: z.string(), requiresApproval: z.boolean(), posts: z.boolean() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const kind = typedKind(ctx, input.entity);
    if (kind === "maestro" && input.posts) throw invalid(`maestro ${input.entity} cannot post`, "Un maestro no contabiliza");
    await ctx.tx`
      insert into kernel.entity_type_settings (company_id, entity, requires_approval, posts)
      values (${ctx.companyId}, ${input.entity}, ${input.requiresApproval}, ${input.posts})
      on conflict (company_id, entity) do update set requires_approval = excluded.requires_approval, posts = excluded.posts`;
    return { entity: input.entity, requiresApproval: input.requiresApproval, posts: input.posts };
  },
});

export const stateRecipientsUpdate = defineProcess({
  id: "kernel.state_recipients.update",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Define a quién se avisa por correo cuando un registro de un maestro o documento llega a un estado; una lista vacía deja de avisar",
  input: z.object({ entity: z.string().min(1), status: z.enum(STATUSES), emails: z.array(z.string()).max(50, "Máximo 50 correos") }),
  output: z.object({ entity: z.string(), status: z.string(), emails: z.array(z.string()) }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const kind = typedKind(ctx, input.entity);
    if (kind === "maestro" && !MAESTRO_STATUSES.includes(input.status)) {
      throw invalid(`maestro ${input.entity} has no status ${input.status}`, `Un maestro no tiene el estado ${input.status}`);
    }
    const emails: string[] = [];
    for (const raw of input.emails) {
      const email = raw.trim().toLowerCase();
      const problem = validateEmail(email);
      if (problem) throw invalid(`invalid e-mail ${raw}`, `${raw}: ${problem}`);
      if (!emails.includes(email)) emails.push(email);
    }
    await ctx.tx`
      insert into kernel.state_recipients (company_id, entity, status, emails)
      values (${ctx.companyId}, ${input.entity}, ${input.status}, ${emails})
      on conflict (company_id, entity, status) do update set emails = excluded.emails`;
    return { entity: input.entity, status: input.status, emails };
  },
});

export const TYPED_SETTINGS_PROCESSES = [entityTypeSettingsUpdate, stateRecipientsUpdate];
