import { customData, type ProcessContext } from "@erp/kernel";
import { rejectErrors } from "./common";

// The `extra` / `extra_free` columns of a master (rule 7, design §5.14), validated against the company's custom fields the way
// the core processes do.

type Given = { extra?: Record<string, unknown> | undefined; extraFree?: { name: string; value: string }[] | undefined };

/** Column values for a create: the validated extra document and the free pairs, each only when the request carries it. */
export async function extraForCreate(ctx: ProcessContext, entityId: string, processId: string, input: Given) {
  const custom = await customData(ctx, entityId, null, input.extra);
  rejectErrors(processId, custom.errors);
  return {
    extra: input.extra !== undefined ? ctx.tx.json(custom.extra as Parameters<typeof ctx.tx.json>[0]) : undefined,
    extra_free: input.extraFree !== undefined ? ctx.tx.json(input.extraFree) : undefined,
  };
}

/** Column values for an update: `extra` replaced or patched against the stored document, `extra_free` replaced. */
export async function extraForUpdate(
  ctx: ProcessContext,
  entityId: string,
  processId: string,
  stored: Record<string, unknown> | null,
  input: Given & { extraPatch?: Record<string, unknown> | undefined },
) {
  const custom = await customData(ctx, entityId, stored, input.extra, input.extraPatch);
  rejectErrors(processId, custom.errors);
  const touched = input.extra !== undefined || input.extraPatch !== undefined;
  return {
    extra: touched ? ctx.tx.json(custom.extra as Parameters<typeof ctx.tx.json>[0]) : undefined,
    extra_free: input.extraFree !== undefined ? ctx.tx.json(input.extraFree) : undefined,
  };
}
