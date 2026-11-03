import { customData, defineProcess, ProcessError, visibleExtra, type CustomData, type ProcessContext, type ProductFiscalInput, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { companyPack, defined, dianStatus, freeJsonb, idInput, idOutput, jsonb, num, refuseDuplicate, rejectErrors, str, undefinedAsNull } from "./common";
import { product } from "../entities";
import { assertWritable, changedColumns, followLifecycle, initialLifecycle, lifecycleProcesses, writableColumns } from "./lifecycle";
import { resolveTaxes, type Taxes, type TaxResolution } from "./product-taxes";
import { extra, extraFree, extraPatch, id, idScheme, incRate, ivaRate, optionalText, otherTaxes, referencePriceType, uomCode } from "./schemas";

// Products (design §5.8b, §5.18). The company's country pack validates every create and update
// (errors refuse with invalid_input, missing data sets dian_status). Taxes and the unit default to
// the category's; tax_override records whether the product's taxes differ from its category. A product is a maestro (entity types
// spec §2.2): created Grabado (Pendiente de Aprobación when required), its update follows the lifecycle (D10), and the generic
// Grabar runs the same validation through the validate hook (Task 8a).

const fields = {
  sku: z.string().trim().min(1),
  description: z.string(),
  kind: z.enum(["good", "service"]),
  idScheme,
  standardCode: optionalText,
  brand: optionalText,
  model: optionalText,
  uomCode: uomCode.optional(),
  ivaRate: ivaRate.optional(),
  incRate: incRate.nullable().optional(),
  otherTaxes: otherTaxes.optional(),
  listPrice: z.number(),
  isFreeSample: z.boolean(),
  referencePriceType: referencePriceType.optional(),
  referencePrice: z.number().optional(),
  standardCost: z.number().optional(),
  trackStock: z.boolean(),
  minStock: z.number().optional(),
  categoryId: id.nullable().optional(),
  supplierId: id.nullable().optional(),
  extra,
  extraFree,
};

/** What the generic Grabar may write: the update process's columns (no DIAN status / missing data, readiness, tax override). */
const PRODUCT_WRITABLE = writableColumns(fields);

const createInput = z.object({ ...fields, idScheme: fields.idScheme.default("999"), isFreeSample: fields.isFreeSample.default(false) });
type ProductInput = z.output<typeof createInput>;
type Fiscal = Omit<ProductInput, "uomCode" | "ivaRate" | "incRate" | "otherTaxes" | "categoryId" | "supplierId" | "extra" | "extraFree">;

/** Unique constraint on (company_id, sku). */
const SKU_KEY = "products_company_id_sku_key";

type Category = Taxes & { defaultUom: string | null };

/**
 * The category to assign, visible in the caller's company: it must be usable (kernel.record_usable: not deleted, Activo, Grabado or,
 * when it requires approval, Aprobado), else the run is refused.
 */
async function assignableCategory(ctx: ProcessContext, processId: string, categoryId: string): Promise<Category> {
  const [row] = await ctx.tx<{ iva_rate: string; inc_rate: string | null; other_taxes: string[]; default_uom: string | null; is_active: boolean; usable: boolean }[]>`
    select iva_rate, inc_rate, other_taxes, default_uom, is_active, kernel.record_usable('core.product_category', id) as usable
    from core.product_categories where id = ${categoryId} and deleted_at is null`;
  if (!row) rejectErrors(processId, ["La categoría no existe"]);
  if (!row!.is_active) rejectErrors(processId, ["La categoría está inactiva"]);
  if (!row!.usable) rejectErrors(processId, ["La categoría no está grabada o aprobada"]);
  return { ivaRate: row!.iva_rate, incRate: row!.inc_rate, otherTaxes: row!.other_taxes, defaultUom: row!.default_uom };
}

/** The stored category's taxes and unit, without the assignability checks (a product keeps the category it already has). */
async function categoryTaxes(ctx: ProcessContext, categoryId: string): Promise<Category | null> {
  const [row] = await ctx.tx<{ iva_rate: string; inc_rate: string | null; other_taxes: string[]; default_uom: string | null }[]>`
    select iva_rate, inc_rate, other_taxes, default_uom from core.product_categories where id = ${categoryId}`;
  return row ? { ivaRate: row.iva_rate, incRate: row.inc_rate, otherTaxes: row.other_taxes, defaultUom: row.default_uom } : null;
}

/** The supplier must be a party of kind supplier the caller sees through core.v_parties (company and party scope). */
async function assertSupplier(ctx: ProcessContext, processId: string, supplierId: string): Promise<void> {
  const rows = await ctx.tx`
    select 1 from core.v_parties v join core.parties p on p.id = v.id
    where v.id = ${supplierId} and p.kind @> array['supplier']`;
  if (rows.length === 0) rejectErrors(processId, ["El proveedor no existe o no es un tercero de tipo proveedor"]);
}

/**
 * Validates with the company's pack, then with the company's custom fields (a required one left empty is missing
 * data next to the pack's), and maps the normalized product to columns.
 */
async function validated(ctx: ProcessContext, processId: string, fiscal: Fiscal, uom: string | undefined, resolution: TaxResolution, custom: CustomData) {
  const { taxes } = resolution;
  const required: string[] = [];
  if (!uom) required.push("Unidad de medida: indícala o elige una categoría que la defina");
  if (!taxes.ivaRate) required.push("Tarifa de IVA: indícala o elige una categoría que la defina");
  rejectErrors(processId, required);
  const pack = await companyPack(ctx);
  const input: ProductFiscalInput = {
    ...fiscal,
    uomCode: uom!,
    ivaRate: taxes.ivaRate as ProductFiscalInput["ivaRate"],
    incRate: (taxes.incRate ?? undefined) as ProductFiscalInput["incRate"],
    otherTaxes: taxes.otherTaxes,
  };
  const result = pack.validateProduct(input);
  rejectErrors(processId, result.errors);
  rejectErrors(processId, custom.errors);
  const missing = [...result.missing, ...custom.missing];
  const n = result.normalized;
  return {
    sku: n.sku,
    description: n.description,
    kind: n.kind,
    id_scheme: n.idScheme,
    standard_code: n.standardCode,
    brand: n.brand,
    model: n.model,
    uom_code: n.uomCode,
    iva_rate: n.ivaRate,
    inc_rate: n.incRate,
    other_taxes: [...n.otherTaxes],
    tax_override: resolution.taxOverride,
    list_price: n.listPrice,
    is_free_sample: n.isFreeSample,
    reference_price_type: n.referencePriceType,
    reference_price: n.referencePrice,
    standard_cost: n.standardCost,
    track_stock: n.trackStock,
    min_stock: n.minStock,
    dian_status: dianStatus(missing),
    dian_missing: missing,
  };
}

const duplicateDetail = (sku: string) => `Ya existe un producto con el código ${sku}`;

/** The stored product's fiscal fields. */
function fiscalOf(row: Record<string, unknown>): Fiscal {
  return {
    sku: String(row.sku),
    description: String(row.description),
    kind: row.kind as Fiscal["kind"],
    idScheme: row.id_scheme as Fiscal["idScheme"],
    standardCode: str(row.standard_code),
    brand: str(row.brand),
    model: str(row.model),
    listPrice: Number(row.list_price),
    isFreeSample: Boolean(row.is_free_sample),
    referencePriceType: str(row.reference_price_type) as Fiscal["referencePriceType"],
    referencePrice: num(row.reference_price),
    standardCost: num(row.standard_cost),
    trackStock: Boolean(row.track_stock),
    minStock: num(row.min_stock),
  };
}

export const productCreate = defineProcess({
  id: "core.product.create",
  module: "core",
  kind: "create",
  feature: "core.products",
  description: "Crea un producto o servicio con los datos que exige la factura electrónica",
  input: createInput,
  output: idOutput,
  handler: async (ctx, input) => {
    const { uomCode: uom, ivaRate: iva, incRate: inc, otherTaxes: other, categoryId, supplierId, extra: extraData, extraFree: freeData, ...fiscal } = input;
    const category = categoryId ? await assignableCategory(ctx, "core.product.create", categoryId) : null;
    if (supplierId) await assertSupplier(ctx, "core.product.create", supplierId);
    const resolution = resolveTaxes({ explicit: { ivaRate: iva, incRate: inc, otherTaxes: other }, category, categoryChanged: true });
    const custom = await customData(ctx, "core.product", null, extraData);
    const row = await validated(ctx, "core.product.create", fiscal, uom ?? category?.defaultUom ?? undefined, resolution, custom);
    const values = {
      company_id: ctx.companyId,
      ...(await initialLifecycle(ctx, "core.product")),
      ...defined(row),
      ...defined({ category_id: categoryId, supplier_id: supplierId, extra: jsonb(ctx, custom.extra), extra_free: freeJsonb(ctx, freeData) }),
    };
    const [inserted] = await refuseDuplicate("core.product.create", SKU_KEY, duplicateDetail(row.sku), () =>
      ctx.tx<{ id: string }[]>`insert into core.products ${ctx.tx(values)} returning id`,
    );
    await ctx.emit("core.product.created", { id: inserted!.id });
    return { id: inserted!.id };
  },
});

export const productUpdate = defineProcess({
  id: "core.product.update",
  module: "core",
  kind: "update",
  feature: "core.products",
  description: "Actualiza un producto y recalcula su estado DIAN; cambiar la categoría hereda sus impuestos",
  input: z.object(fields).partial().extend({ id, extraPatch }),
  output: idOutput,
  handler: async (ctx, { id: productId, extraPatch: patch, ...input }) => {
    const [current] = await ctx.tx`select * from core.products where id = ${productId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `product ${productId} not found`);
    const { uomCode: uom, ivaRate: iva, incRate: inc, otherTaxes: other, categoryId, supplierId, extra: extraData, extraFree: freeData, ...changes } = input;

    const storedCategory = (current.category_id as string | null) ?? null;
    const categoryChanged = categoryId !== undefined && categoryId !== storedCategory;
    const targetCategory = categoryId !== undefined ? categoryId : storedCategory;
    let category: Category | null = null;
    if (targetCategory && categoryChanged) category = await assignableCategory(ctx, "core.product.update", targetCategory);
    else if (targetCategory) category = await categoryTaxes(ctx, targetCategory);
    if (supplierId) await assertSupplier(ctx, "core.product.update", supplierId);

    const stored: TaxResolution = {
      taxes: { ivaRate: String(current.iva_rate), incRate: (current.inc_rate as string | null) ?? null, otherTaxes: current.other_taxes as string[] },
      taxOverride: Boolean(current.tax_override),
    };
    const resolution = resolveTaxes({ explicit: { ivaRate: iva, incRate: inc, otherTaxes: other }, category, current: stored, categoryChanged });
    const fiscal: Fiscal = { ...fiscalOf(current), ...defined(changes) };
    const custom = await customData(ctx, "core.product", current.extra as Record<string, unknown> | null, extraData, patch);
    const row = await validated(ctx, "core.product.update", fiscal, uom ?? String(current.uom_code), resolution, custom);
    const set = {
      ...undefinedAsNull(row),
      ...defined({ category_id: categoryId, supplier_id: supplierId, extra: jsonb(ctx, custom.extra), extra_free: freeJsonb(ctx, freeData) }),
    };
    await refuseDuplicate("core.product.update", SKU_KEY, duplicateDetail(row.sku), () =>
      ctx.tx`update core.products set ${ctx.tx(set)} where id = ${productId}`,
    );
    // Grabar's lifecycle step: the state, the validate hook (which emits core.product.updated) and D10.
    await followLifecycle(ctx, "core.product", productId, current);
    return { id: productId };
  },
});

export const productDeactivate = defineProcess({
  id: "core.product.deactivate",
  module: "core",
  kind: "delete",
  feature: "core.products",
  description: "Desactiva un producto: deja de estar disponible para documentos nuevos",
  input: idInput,
  output: idOutput,
  handler: async (ctx, { id: productId }) => {
    const rows = await ctx.tx`update core.products set is_active = false where id = ${productId} and deleted_at is null returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `product ${productId} not found`);
    await ctx.emit("core.product.updated", { id: productId });
    return { id: productId };
  },
});

export const productConsult = defineProcess({
  id: "core.product.consult",
  module: "core",
  kind: "consult",
  feature: "core.products",
  description: "Consulta un producto con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: productId }) => {
    const [row] = await ctx.tx`select * from core.v_products where id = ${productId}`;
    if (!row) throw new ProcessError("not_found", `product ${productId} not found`);
    return { ...row, id: productId, extra: await visibleExtra(ctx, "core.product", row.extra) };
  },
});

/** A stored column as one of the tax codes (to_jsonb gives text as strings, a null as null). */
const code = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/**
 * The validate hook of core.product (Grabar, Aprobar): the record as stored after the step goes through the update process's checks:
 * a category it moves to must be assignable and gives its taxes (unless the step set them), a supplier it moves to must be a visible
 * supplier, then the country pack and the custom fields; the normalized values, the taxes and the DIAN status are written back
 * (rule 10) and Grabar emits core.product.updated. Grabar does not deactivate: Activo = no is core.product.deactivate.
 */
export const productHooks: TypedHooks = {
  async validate(ctx, record, mode, { previous, data = {} }) {
    const processId = `core.product.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, PRODUCT_WRITABLE);
    if (previous.is_active === true && record.is_active === false) {
      rejectErrors(processId, ["Para desactivar un producto usa Desactivar (Activo = no)"]);
    }
    const categoryId = code(record.category_id);
    const categoryChanged = categoryId !== code(previous.category_id);
    const category = !categoryId ? null : categoryChanged ? await assignableCategory(ctx, processId, categoryId) : await categoryTaxes(ctx, categoryId);
    const supplierId = code(record.supplier_id);
    if (supplierId && supplierId !== code(previous.supplier_id)) await assertSupplier(ctx, processId, supplierId);
    const stored: TaxResolution = {
      taxes: { ivaRate: String(previous.iva_rate), incRate: code(previous.inc_rate), otherTaxes: (previous.other_taxes as string[] | null) ?? [] },
      taxOverride: previous.tax_override === true,
    };
    // Taxes the step set explicitly win over the category's (as in the update process).
    const explicit = {
      ivaRate: "iva_rate" in data ? (code(record.iva_rate) ?? undefined) : undefined,
      incRate: "inc_rate" in data ? code(record.inc_rate) : undefined,
      otherTaxes: "other_taxes" in data ? ((record.other_taxes as string[] | null) ?? []) : undefined,
    };
    const resolution = resolveTaxes({ explicit, category, current: stored, categoryChanged });
    const custom = await customData(ctx, "core.product", record.extra as Record<string, unknown> | null, undefined);
    const row = await validated(ctx, processId, fiscalOf(record), code(record.uom_code) ?? undefined, resolution, custom);
    const set = changedColumns(record, undefinedAsNull(row));
    if (Object.keys(set).length > 0) {
      await refuseDuplicate(processId, SKU_KEY, duplicateDetail(row.sku), () => ctx.tx`update core.products set ${ctx.tx(set)} where id = ${record.id}`);
    }
    if (mode === "save") await ctx.emit("core.product.updated", { id: record.id });
  },
};

/** The generic lifecycle processes of core.product; Grabar refuses a duplicate SKU. */
export const PRODUCT_LIFECYCLE = lifecycleProcesses(product, "core.products", {
  duplicate: {
    constraint: SKU_KEY,
    detail: async (ctx, productId, data) => {
      const [stored] = await ctx.tx<{ sku: string }[]>`select sku from core.products where id = ${productId}`;
      return duplicateDetail(String(data.sku ?? stored?.sku ?? ""));
    },
  },
});

export const PRODUCT_PROCESSES = [productCreate, productUpdate, productDeactivate, productConsult, ...PRODUCT_LIFECYCLE];
