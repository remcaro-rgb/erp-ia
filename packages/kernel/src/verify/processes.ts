import { z } from "zod";
import { registeredEntity, requireVisibleRecord } from "../attachments/guards";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { normalizeVerifyValue, verify } from "./verify";

// The processes behind the Verificar control of e-mail, phone and identification fields (design §5.16).

const FEATURE = "kernel.verification";

const kind = z.enum(["email", "phone", "document"]);
const target = z.object({ kind, value: z.string().min(1).max(200), entity: z.string().min(1), recordId: z.uuid() });

const statusOutput = z.enum(["queued", "verified", "failed"]);

export const verifyRequest = defineProcess({
  id: "kernel.verify.request",
  module: "kernel",
  kind: "update",
  feature: FEATURE,
  description: "Pide verificar un correo, teléfono o identificación con el proveedor externo; sin proveedor la solicitud queda en cola",
  input: target,
  output: z.object({ id: z.string(), status: statusOutput, provider: z.string().nullable() }),
  handler: async (ctx, input) => {
    const entity = registeredEntity(ctx, input.entity);
    await requireVisibleRecord(ctx, entity, input.recordId);
    const normalized = normalizeVerifyValue(input.kind, input.value);
    if ("error" in normalized) throw new ProcessError("invalid_input", "value cannot be verified", { details: [normalized.error] });
    return verify(ctx.tx, input.kind, normalized.value, { companyId: ctx.companyId, entity: entity.id, recordId: input.recordId });
  },
});

export const verifyStatus = defineProcess({
  id: "kernel.verify.status",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta el estado de la última verificación pedida para un dato de un registro",
  input: target,
  output: z
    .object({ id: z.string(), status: statusOutput, provider: z.string().nullable(), requestedAt: z.string() })
    .nullable(),
  handler: async (ctx, input) => {
    const entity = registeredEntity(ctx, input.entity);
    await requireVisibleRecord(ctx, entity, input.recordId);
    const normalized = normalizeVerifyValue(input.kind, input.value);
    const value = "value" in normalized ? normalized.value : input.value.trim();
    const [row] = await ctx.tx<{ id: string; status: "queued" | "verified" | "failed"; provider: string | null; created_at: Date }[]>`
      select id, status, provider, created_at from kernel.verification_requests
      where company_id = ${ctx.companyId} and entity = ${entity.id} and record_id = ${input.recordId} and kind = ${input.kind} and value = ${value}
      order by created_at desc, id desc limit 1`;
    return row ? { id: row.id, status: row.status, provider: row.provider, requestedAt: row.created_at.toISOString() } : null;
  },
});

export const VERIFY_PROCESSES = [verifyRequest, verifyStatus];
