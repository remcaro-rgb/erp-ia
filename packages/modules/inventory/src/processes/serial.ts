import { customData, defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { serialEntity } from "../entities";
import { assertWritable, extra, followLifecycle, id, idInput, idOutput, initialLifecycle, maestroLifecycle, refuse, refuseDuplicate, rejectErrors } from "./common";
import { assertProduct, trackingOf } from "./tracking";

// Seriales (plan 2B.2 Task 28.1, PG §3.1): one unit of a product tracked by serial, its number unique per product whatever its case,
// optionally inside a lot of the same product. Its `serial_status` is kept by the movements only (28.2: a receipt makes it `available`,
// an issue `issued`, a write-off `scrapped`); a serial registered here has none until a receipt brings it, and update changes only its note.

const FEATURE = "inventory.stock";
const SERIAL_KEY = "serials_product_serial_key";
const SERIAL_WRITABLE = ["note", "is_active", "extra", "extra_free"];

const serialNo = z.string().trim().min(1).max(80);
const note = z.string().trim().max(500);

const duplicate = (no: string) => `El producto ya tiene el serial ${no}`;

async function validExtra(ctx: ProcessContext, processId: string, stored: Record<string, unknown> | null, given: Record<string, unknown> | undefined) {
  const custom = await customData(ctx, "inventory.serial", stored, given);
  rejectErrors(processId, custom.errors);
  return given === undefined ? {} : { extra: ctx.tx.json(custom.extra as Parameters<typeof ctx.tx.json>[0]) };
}

export const serialCreate = defineProcess({
  id: "inventory.serial.create",
  module: "inventory",
  kind: "create",
  feature: FEATURE,
  description: "Registra un serial de un producto que se sigue por serial (número único por producto), opcionalmente dentro de un lote del mismo producto",
  input: z.object({ productId: id, serialNo, lotId: id.optional(), note: note.optional(), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { productId, extra: given, ...input }) => {
    await assertProduct(ctx, productId);
    if ((await trackingOf(ctx.tx, productId)).tracking !== "serial") {
      refuse("product_not_tracked_by_serial", ["El producto no se sigue por serial: cambia su seguimiento en Parámetros › Seguimiento por producto"]);
    }
    if (input.lotId) {
      const [lot] = await ctx.tx`select 1 from inventory.lots where id = ${input.lotId} and product_id = ${productId} and deleted_at is null`;
      if (!lot) refuse("lot_not_found", ["El lote no existe o es de otro producto"]);
    }
    const extraColumn = await validExtra(ctx, "inventory.serial.create", null, given);
    const state = await initialLifecycle(ctx, "inventory.serial");
    const [row] = await refuseDuplicate("inventory.serial.create", SERIAL_KEY, duplicate(input.serialNo), () =>
      ctx.tx<{ id: string }[]>`
        insert into inventory.serials ${ctx.tx({
          company_id: ctx.companyId, product_id: productId, serial_no: input.serialNo, lot_id: input.lotId ?? null, note: input.note ?? null,
          serial_status: null, ...extraColumn, ...state,
        })}
        returning id`,
    ).catch((error: unknown) => {
      if (error instanceof ProcessError && error.message.startsWith("duplicate in")) refuse("serial_exists", [duplicate(input.serialNo)]);
      throw error;
    });
    return { id: row!.id };
  },
});

export const serialUpdate = defineProcess({
  id: "inventory.serial.update",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  description: "Actualiza la nota de un serial; su estado lo llevan los movimientos de inventario",
  input: z.object({ id, note: note.nullable().optional(), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: serialId, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from inventory.serials where id = ${serialId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `serial ${serialId} not found`);
    const set = { ...(input.note === undefined ? {} : { note: input.note }), ...(await validExtra(ctx, "inventory.serial.update", current.extra as Record<string, unknown> | null, given)) };
    if (Object.keys(set).length > 0) await ctx.tx`update inventory.serials set ${ctx.tx(set)} where id = ${serialId}`;
    await followLifecycle(ctx, "inventory.serial", serialId, current);
    return { id: serialId };
  },
});

export const serialConsult = defineProcess({
  id: "inventory.serial.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un serial (producto, número, lote, estado) con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: serialId }) => {
    const [row] = await ctx.tx`select * from inventory.v_serials where id = ${serialId}`;
    if (!row) throw new ProcessError("not_found", `serial ${serialId} not found`);
    return { ...row, id: serialId, extra: await visibleExtra(ctx, "inventory.serial", row.extra) };
  },
});

/** The validate hook of a serial (Grabar, Aprobar): only the note, Activo and the extra data are writable; the custom fields pass. */
export const serialHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `inventory.serial.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, SERIAL_WRITABLE);
    const parsed = serialNo.safeParse(record.serial_no);
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `serial_no: ${issue.message}`));
    const custom = await customData(ctx, "inventory.serial", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

export const SERIAL_PROCESSES = [
  serialCreate, serialUpdate, serialConsult,
  ...maestroLifecycle(serialEntity, FEATURE, { constraint: SERIAL_KEY, detail: "El producto ya tiene un serial con ese número" }),
];
