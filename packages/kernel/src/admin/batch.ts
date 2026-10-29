import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import type { ProcessContext } from "../process/context";
import { ADMIN_FEATURE, requireAdmin } from "./common";
import {
  checkFieldPermissionChange,
  checkPermissionChange,
  fieldPermissionChange,
  permissionChange,
  roleLookup,
  writeFieldPermissions,
  writePermissions,
  type RoleLookup,
} from "./permissions";

// OD-7 (design §22.11): the permission and field visibility matrices stage their cells and apply them together, with one
// step-up. Each batch is one process run, so one transaction: every change goes through the same check as the single
// process (kernel.admin.permission.set / field_permission.set, which stay for the assistant), and one refused change
// refuses the whole batch with the index of each refused change in `details`, writing nothing. The process audit row
// lists every change; the row triggers record the before/after of each cell (rule 16).

/** The most cells one batch carries (the matrix of a company with its modules and roles fits well under it). */
export const MAX_BATCH = 500;

/** A refused change of a batch: its position in `changes` and the reason the admin screen shows (es-419). */
export interface BatchRefusal {
  index: number;
  message: string;
}

/** `changes` with no two entries for the same cell (the matrix sends one value per cell). */
function batchOf<T extends z.ZodTypeAny>(change: T, cell: (c: z.infer<T>) => string, repeated: string) {
  return z
    .object({ changes: z.array(change).min(1).max(MAX_BATCH) })
    .superRefine((value, ctx) => {
      const seen = new Set<string>();
      value.changes.forEach((c: z.infer<T>, index: number) => {
        const key = cell(c);
        if (seen.has(key)) ctx.addIssue({ code: "custom", path: ["changes", index], message: repeated });
        seen.add(key);
      });
    });
}

/** Runs `check` on every change; refuses the batch, before anything is written, when any of them is refused. */
async function checkAll<C>(ctx: ProcessContext, changes: C[], check: (ctx: ProcessContext, change: C, roleOf: RoleLookup) => Promise<void>): Promise<void> {
  const roleOf = roleLookup(ctx);
  const refused: BatchRefusal[] = [];
  for (const [index, change] of changes.entries()) {
    try {
      await check(ctx, change, roleOf);
    } catch (error) {
      if (!(error instanceof ProcessError) || error.code !== "invalid_input") throw error;
      const message = Array.isArray(error.details) && error.details.length > 0 ? String(error.details[0]) : error.message;
      refused.push({ index, message });
    }
  }
  if (refused.length > 0) {
    throw new ProcessError("invalid_input", `batch refused: changes ${refused.map((r) => r.index).join(", ")}`, { details: refused });
  }
}

const permissionBatch = batchOf(permissionChange, (c) => `${c.roleId}:${c.processId}`, "Ese permiso está repetido en la lista de cambios");
const fieldBatch = batchOf(fieldPermissionChange, (c) => `${c.roleId}:${c.entity}.${c.field}`, "Ese campo está repetido en la lista de cambios");
const batchOutput = z.object({ count: z.number().int() });

export const permissionSetMany = defineProcess({
  id: "kernel.admin.permission.set_many",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Aplica juntos varios cambios de la matriz de permisos (permitir o negar procesos a roles) con una sola verificación",
  input: permissionBatch,
  output: batchOutput,
  // The audit row lists every change of the batch (at most MAX_BATCH, never truncated).
  auditInput: (input) => ({ changes: input.changes }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    await checkAll(ctx, input.changes, checkPermissionChange);
    await writePermissions(ctx, input.changes);
    return { count: input.changes.length };
  },
});

export const fieldPermissionSetMany = defineProcess({
  id: "kernel.admin.field_permission.set_many",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Aplica juntos varios cambios de visibilidad de campos por rol (visible, enmascarado u oculto) con una sola verificación",
  input: fieldBatch,
  output: batchOutput,
  auditInput: (input) => ({ changes: input.changes }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    await checkAll(ctx, input.changes, checkFieldPermissionChange);
    await writeFieldPermissions(ctx, input.changes);
    return { count: input.changes.length };
  },
});

export const BATCH_PROCESSES = [permissionSetMany, fieldPermissionSetMany];
