import { customData, defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { LOT_STATUSES, lotEntity } from "../entities";
import { assertWritable, defined, extra, followLifecycle, id, idInput, idOutput, initialLifecycle, maestroLifecycle, refuse, refuseDuplicate, rejectErrors } from "./common";
import { assertProduct, trackingOf } from "./tracking";

// Lotes (plan 2B.2 Task 28.1, PG §3.1, item 145): a maestro of one product. Its code is free text the user types or scans, unique per
// product whatever its case (the same supplier lot code may exist on two products). Only a product tracked by lot has lots
// (`product_not_tracked_by_lot`); when its tracking requires expiry a lot without one is refused (`expiry_required`). A receipt creates
// its lot nested through this process (28.2). `lot_status` blocked holds it back from sale (28.3); the maestro lifecycle is the kernel's.

const FEATURE = "inventory.stock";
const LOT_KEY = "lots_product_code_key";
const LOT_WRITABLE = ["code", "expires_on", "produced_on", "lot_status", "note", "is_active", "extra", "extra_free"];

const code = z.string().trim().min(1).max(60);
const day = z.iso.date();
const note = z.string().trim().max(500);
const status = z.enum(LOT_STATUSES);

const duplicate = (codeText: string) => `El producto ya tiene un lote con el código ${codeText}`;

/** The validated extra data to write, or undefined when the request does not touch it. */
async function validExtra(ctx: ProcessContext, processId: string, stored: Record<string, unknown> | null, given: Record<string, unknown> | undefined) {
  const custom = await customData(ctx, "inventory.lot", stored, given);
  rejectErrors(processId, custom.errors);
  return given === undefined ? {} : { extra: ctx.tx.json(custom.extra as Parameters<typeof ctx.tx.json>[0]) };
}

/** Refuses a produced date after the expiry. */
function assertDates(expiresOn: string | null | undefined, producedOn: string | null | undefined): void {
  if (expiresOn && producedOn && producedOn > expiresOn) refuse("invalid_dates", ["La fecha de producción es posterior al vencimiento"]);
}

export const lotCreate = defineProcess({
  id: "inventory.lot.create",
  module: "inventory",
  kind: "create",
  feature: FEATURE,
  description: "Crea un lote de un producto que se sigue por lote: código (único por producto), vencimiento, fecha de producción y nota",
  input: z.object({ productId: id, code, expiresOn: day.optional(), producedOn: day.optional(), note: note.optional(), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { productId, extra: given, ...input }) => {
    await assertProduct(ctx, productId);
    const tracking = await trackingOf(ctx.tx, productId);
    if (tracking.tracking !== "lot") refuse("product_not_tracked_by_lot", ["El producto no se sigue por lote: cambia su seguimiento en Parámetros › Seguimiento por producto"]);
    if (tracking.expiryRequired && !input.expiresOn) refuse("expiry_required", [`El lote ${input.code} necesita fecha de vencimiento`]);
    assertDates(input.expiresOn, input.producedOn);
    const extraColumn = await validExtra(ctx, "inventory.lot.create", null, given);
    const state = await initialLifecycle(ctx, "inventory.lot");
    const [row] = await refuseDuplicate("inventory.lot.create", LOT_KEY, duplicate(input.code), () =>
      ctx.tx<{ id: string }[]>`
        insert into inventory.lots ${ctx.tx({
          company_id: ctx.companyId, product_id: productId, code: input.code, expires_on: input.expiresOn ?? null, produced_on: input.producedOn ?? null,
          note: input.note ?? null, lot_status: "active", ...extraColumn, ...state,
        })}
        returning id`,
    ).catch((error: unknown) => {
      // The accounting convention: the code leads the message (the receipt that nests this create reads it, 28.2).
      if (error instanceof ProcessError && error.message.startsWith("duplicate in")) refuse("lot_exists", [duplicate(input.code)]);
      throw error;
    });
    return { id: row!.id };
  },
});

export const lotUpdate = defineProcess({
  id: "inventory.lot.update",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  description: "Actualiza un lote: vencimiento, fecha de producción, estado (activo o bloqueado para la venta) y nota; el producto y el código no cambian",
  input: z.object({ id, expiresOn: day.nullable().optional(), producedOn: day.nullable().optional(), status: status.optional(), note: note.nullable().optional(), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: lotId, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from inventory.lots where id = ${lotId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `lot ${lotId} not found`);
    const expiresOn = input.expiresOn === undefined ? (current.expires_on as string | null) : input.expiresOn;
    const producedOn = input.producedOn === undefined ? (current.produced_on as string | null) : input.producedOn;
    if (input.expiresOn === null && (await trackingOf(ctx.tx, current.product_id as string)).expiryRequired) {
      refuse("expiry_required", [`El lote ${String(current.code)} necesita fecha de vencimiento`]);
    }
    assertDates(input.expiresOn === undefined ? undefined : expiresOn, input.producedOn === undefined ? undefined : producedOn);
    const set = { ...defined({ expires_on: input.expiresOn, produced_on: input.producedOn, lot_status: input.status, note: input.note }), ...(await validExtra(ctx, "inventory.lot.update", current.extra as Record<string, unknown> | null, given)) };
    if (Object.keys(set).length > 0) await ctx.tx`update inventory.lots set ${ctx.tx(set)} where id = ${lotId}`;
    await followLifecycle(ctx, "inventory.lot", lotId, current);
    return { id: lotId };
  },
});

export const lotConsult = defineProcess({
  id: "inventory.lot.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un lote (producto, código, vencimiento, producción, estado) con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: lotId }) => {
    const [row] = await ctx.tx`select * from inventory.v_lots where id = ${lotId}`;
    if (!row) throw new ProcessError("not_found", `lot ${lotId} not found`);
    return { ...row, id: lotId, extra: await visibleExtra(ctx, "inventory.lot", row.extra) };
  },
});

/** The validate hook of a lote (Grabar, Aprobar): the stored record passes the create schema and the custom fields. */
export const lotHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `inventory.lot.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, LOT_WRITABLE);
    const parsed = z.object({ code, status }).safeParse({ code: record.code, status: record.lot_status });
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    const custom = await customData(ctx, "inventory.lot", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

export const LOT_PROCESSES = [
  lotCreate, lotUpdate, lotConsult,
  ...maestroLifecycle(lotEntity, FEATURE, { constraint: LOT_KEY, detail: "El producto ya tiene un lote con ese código" }),
];
