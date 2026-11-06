import { customData, defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { LOCATION_KINDS, locationEntity, warehouseEntity } from "../entities";
import { assertWritable, defined, extra, followLifecycle, id, idInput, idOutput, initialLifecycle, maestroLifecycle, refuseDuplicate, rejectErrors } from "./common";

// Bodegas and ubicaciones (plan 2B Task 6): maestros (entity types spec §2.2) created Grabado (Pendiente de Aprobación when the company
// requires it), Activo is `is_active`. A bodega allows backorders or not (OD-3: by default an issue below zero is refused). A ubicación
// belongs to one bodega for good: its stock rows name both. Codes are unique per company (bodegas) and per bodega (ubicaciones), whatever
// their case, among the records not deleted.

const FEATURE = "inventory.warehouses";

const code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/, "El código lleva de 1 a 20 letras, números, punto, guion o guion bajo");
const name = z.string().trim().min(1).max(120);

const warehouseFields = {
  code,
  name,
  addressLine: z.string().trim().max(200).optional(),
  allowBackorders: z.boolean(),
  isActive: z.boolean(),
};
const WAREHOUSE_KEY = "warehouses_company_code_key";
const WAREHOUSE_WRITABLE = ["code", "name", "address_line", "allow_backorders", "is_active", "extra", "extra_free"];

const locationFields = { code, name, kind: z.enum(LOCATION_KINDS as [string, ...string[]]), isActive: z.boolean() };
const LOCATION_KEY = "locations_warehouse_code_key";
const LOCATION_WRITABLE = ["code", "name", "kind", "is_active", "extra", "extra_free"];

const warehouseColumns = (input: Partial<z.output<z.ZodObject<typeof warehouseFields>>>) =>
  defined({ code: input.code, name: input.name, address_line: input.addressLine, allow_backorders: input.allowBackorders, is_active: input.isActive });
const locationColumns = (input: Partial<z.output<z.ZodObject<typeof locationFields>>>) =>
  defined({ code: input.code, name: input.name, kind: input.kind, is_active: input.isActive });

/** The validated extra data to write (custom fields of the company), or undefined when the request does not touch it. */
async function validExtra(ctx: ProcessContext, entityId: string, processId: string, stored: Record<string, unknown> | null, given: Record<string, unknown> | undefined): Promise<{ value: Record<string, unknown> } | undefined> {
  const custom = await customData(ctx, entityId, stored, given);
  rejectErrors(processId, custom.errors);
  return given === undefined ? undefined : { value: custom.extra as Record<string, unknown> };
}

const extraColumn = (ctx: ProcessContext, extraValue: { value: Record<string, unknown> } | undefined) =>
  extraValue ? { extra: ctx.tx.json(extraValue.value as Parameters<typeof ctx.tx.json>[0]) } : {};

export const warehouseCreate = defineProcess({
  id: "inventory.warehouse.create",
  module: "inventory",
  kind: "create",
  feature: FEATURE,
  description: "Crea una bodega; por defecto no permite existencias negativas",
  input: z.object({ ...warehouseFields, allowBackorders: warehouseFields.allowBackorders.default(false), isActive: warehouseFields.isActive.default(true), extra }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const extraJson = await validExtra(ctx, "inventory.warehouse", "inventory.warehouse.create", null, input.extra);
    const state = await initialLifecycle(ctx, "inventory.warehouse");
    const [row] = await refuseDuplicate("inventory.warehouse.create", WAREHOUSE_KEY, `Ya existe una bodega con el código ${input.code}`, () =>
      ctx.tx<{ id: string }[]>`
        insert into inventory.warehouses ${ctx.tx({ company_id: ctx.companyId, ...warehouseColumns(input), ...extraColumn(ctx, extraJson), ...state })}
        returning id`,
    );
    return { id: row!.id };
  },
});

export const warehouseUpdate = defineProcess({
  id: "inventory.warehouse.update",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  description: "Actualiza una bodega: código, nombre, dirección, si permite existencias negativas y si está activa",
  input: z.object(warehouseFields).partial().extend({ id, extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: warehouseId, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from inventory.warehouses where id = ${warehouseId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `warehouse ${warehouseId} not found`);
    const extraJson = await validExtra(ctx, "inventory.warehouse", "inventory.warehouse.update", current.extra as Record<string, unknown> | null, given);
    const set = { ...warehouseColumns(input), ...extraColumn(ctx, extraJson) };
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("inventory.warehouse.update", WAREHOUSE_KEY, `Ya existe una bodega con el código ${input.code ?? ""}`, () =>
        ctx.tx`update inventory.warehouses set ${ctx.tx(set)} where id = ${warehouseId}`,
      );
    }
    await followLifecycle(ctx, "inventory.warehouse", warehouseId, current);
    return { id: warehouseId };
  },
});

export const warehouseConsult = defineProcess({
  id: "inventory.warehouse.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una bodega con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: warehouseId }) => {
    const [row] = await ctx.tx`select * from inventory.v_warehouses where id = ${warehouseId}`;
    if (!row) throw new ProcessError("not_found", `warehouse ${warehouseId} not found`);
    return { ...row, id: warehouseId, extra: await visibleExtra(ctx, "inventory.warehouse", row.extra) };
  },
});

export const locationCreate = defineProcess({
  id: "inventory.location.create",
  module: "inventory",
  kind: "create",
  feature: FEATURE,
  description: "Crea una ubicación dentro de una bodega",
  input: z.object({ ...locationFields, warehouseId: id, kind: locationFields.kind.default("storage"), isActive: locationFields.isActive.default(true), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { warehouseId, extra: given, ...input }) => {
    const [warehouse] = await ctx.tx`select id from inventory.warehouses where id = ${warehouseId} and deleted_at is null`;
    if (!warehouse) rejectErrors("inventory.location.create", ["La bodega no existe"]);
    const extraJson = await validExtra(ctx, "inventory.location", "inventory.location.create", null, given);
    const state = await initialLifecycle(ctx, "inventory.location");
    const [row] = await refuseDuplicate("inventory.location.create", LOCATION_KEY, `La bodega ya tiene una ubicación con el código ${input.code}`, () =>
      ctx.tx<{ id: string }[]>`
        insert into inventory.locations ${ctx.tx({ company_id: ctx.companyId, warehouse_id: warehouseId, ...locationColumns(input), ...extraColumn(ctx, extraJson), ...state })}
        returning id`,
    );
    return { id: row!.id };
  },
});

export const locationUpdate = defineProcess({
  id: "inventory.location.update",
  module: "inventory",
  kind: "update",
  feature: FEATURE,
  description: "Actualiza una ubicación: código, nombre, tipo y si está activa; la bodega no cambia",
  input: z.object(locationFields).partial().extend({ id, extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: locationId, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from inventory.locations where id = ${locationId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `location ${locationId} not found`);
    const extraJson = await validExtra(ctx, "inventory.location", "inventory.location.update", current.extra as Record<string, unknown> | null, given);
    const set = { ...locationColumns(input), ...extraColumn(ctx, extraJson) };
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("inventory.location.update", LOCATION_KEY, `La bodega ya tiene una ubicación con el código ${input.code ?? ""}`, () =>
        ctx.tx`update inventory.locations set ${ctx.tx(set)} where id = ${locationId}`,
      );
    }
    await followLifecycle(ctx, "inventory.location", locationId, current);
    return { id: locationId };
  },
});

export const locationConsult = defineProcess({
  id: "inventory.location.consult",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una ubicación de bodega con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: locationId }) => {
    const [row] = await ctx.tx`select * from inventory.v_locations where id = ${locationId}`;
    if (!row) throw new ProcessError("not_found", `location ${locationId} not found`);
    return { ...row, id: locationId, extra: await visibleExtra(ctx, "inventory.location", row.extra) };
  },
});

/** The validate hook of a bodega (Grabar, Aprobar): the stored record passes the create schema and the custom fields. */
export const warehouseHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `inventory.warehouse.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, WAREHOUSE_WRITABLE);
    const parsed = z.object(warehouseFields).safeParse({
      code: record.code, name: record.name, addressLine: record.address_line ?? undefined, allowBackorders: record.allow_backorders, isActive: record.is_active,
    });
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    const custom = await customData(ctx, "inventory.warehouse", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

/** The validate hook of a ubicación (Grabar, Aprobar): the stored record passes the create schema and the custom fields. */
export const locationHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `inventory.location.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, LOCATION_WRITABLE);
    const parsed = z.object(locationFields).safeParse({ code: record.code, name: record.name, kind: record.kind, isActive: record.is_active });
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    const custom = await customData(ctx, "inventory.location", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

export const WAREHOUSE_PROCESSES = [
  warehouseCreate, warehouseUpdate, warehouseConsult, locationCreate, locationUpdate, locationConsult,
  ...maestroLifecycle(warehouseEntity, FEATURE, { constraint: WAREHOUSE_KEY, detail: "Ya existe una bodega con ese código" }),
  ...maestroLifecycle(locationEntity, FEATURE, { constraint: LOCATION_KEY, detail: "La bodega ya tiene una ubicación con ese código" }),
];
