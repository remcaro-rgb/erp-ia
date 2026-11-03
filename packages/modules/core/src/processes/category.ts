import { customData, defineProcess, ProcessError, visibleExtra, type CustomData, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { blank, defined, freeJsonb, idInput, idOutput, jsonb, refuseDuplicate, rejectErrors } from "./common";
import { productCategory } from "../entities";
import { assertWritable, followLifecycle, initialLifecycle, lifecycleProcesses, writableColumns } from "./lifecycle";
import { clearable, extra, extraFree, extraPatch, id, incRate, ivaRate, otherTaxes, uomCode } from "./schemas";

// Product categories (design §5.18): a master whose taxes a product copies when it is assigned.
// Changing a category never rewrites the products that already use it. Names are unique per company
// without regard to case (unique index on lower(name)). A category is a maestro (entity types spec §2.2): created Grabado
// (Pendiente de Aprobación when required), Activo is `is_active` (its old active / inactive status became the lifecycle state in
// migration 0042), and the generic Grabar runs the same checks through the validate hook (Task 8a).

const fields = {
  name: z.string().trim().min(1).max(100),
  ivaRate,
  incRate: incRate.nullable().optional(),
  otherTaxes,
  defaultUom: clearable(uomCode).optional(),
  incomeAccount: clearable(z.string().trim().max(20)).optional(),
  isActive: z.boolean(),
  extra,
  extraFree,
};
type CategoryFields = Partial<z.output<z.ZodObject<typeof fields>>>;

/** What the generic Grabar may write: the update process's columns. */
const CATEGORY_WRITABLE = writableColumns(fields);

/** Unique index on (company_id, lower(name)). */
const NAME_KEY = "product_categories_company_name_key";

/** Column values for the given fields; `custom` carries the validated extra data when the request touches it. */
function columns(ctx: ProcessContext, input: CategoryFields, custom?: CustomData) {
  return {
    name: input.name,
    iva_rate: input.ivaRate,
    inc_rate: input.incRate,
    other_taxes: input.otherTaxes,
    default_uom: blank(input.defaultUom),
    income_account: blank(input.incomeAccount),
    is_active: input.isActive,
    extra: custom && input.extra !== undefined ? jsonb(ctx, custom.extra) : undefined,
    extra_free: freeJsonb(ctx, input.extraFree),
  };
}

const duplicateDetail = (name: string) => `Ya existe una categoría llamada ${name}`;

export const categoryCreate = defineProcess({
  id: "core.category.create",
  module: "core",
  kind: "create",
  feature: "core.products",
  description: "Crea una categoría de productos con sus impuestos por defecto",
  input: z.object({ ...fields, otherTaxes: fields.otherTaxes.default([]), isActive: fields.isActive.default(true) }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const custom = await customData(ctx, "core.product_category", null, input.extra);
    rejectErrors("core.category.create", custom.errors);
    const state = await initialLifecycle(ctx, "core.product_category");
    const [inserted] = await refuseDuplicate(
      "core.category.create",
      NAME_KEY,
      duplicateDetail(input.name),
      () => ctx.tx<{ id: string }[]>`
        insert into core.product_categories ${ctx.tx({ company_id: ctx.companyId, ...defined(columns(ctx, input, custom)), ...state })}
        returning id`,
    );
    return { id: inserted!.id };
  },
});

export const categoryUpdate = defineProcess({
  id: "core.category.update",
  module: "core",
  kind: "update",
  recordAccess: { entity: "core.product_category", idField: "id", right: "modify" },
  feature: "core.products",
  description: "Actualiza una categoría de productos; los productos existentes no cambian",
  input: z.object(fields).partial().extend({ id, extraPatch }).strict(),
  output: idOutput,
  handler: async (ctx, { id: categoryId, extraPatch: patch, ...input }) => {
    const [current] = await ctx.tx`select * from core.product_categories where id = ${categoryId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `category ${categoryId} not found`);
    const custom = await customData(ctx, "core.product_category", current.extra as Record<string, unknown> | null, input.extra, patch);
    rejectErrors("core.category.update", custom.errors);
    const set = defined(columns(ctx, patch !== undefined ? { ...input, extra: custom.extra } : input, custom));
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("core.category.update", NAME_KEY, duplicateDetail(input.name ?? ""), () =>
        ctx.tx`update core.product_categories set ${ctx.tx(set)} where id = ${categoryId}`,
      );
    }
    // Grabar's lifecycle step: the state, the validate hook and D10.
    await followLifecycle(ctx, "core.product_category", categoryId, current);
    return { id: categoryId };
  },
});

export const categoryConsult = defineProcess({
  id: "core.category.consult",
  module: "core",
  kind: "consult",
  feature: "core.products",
  description: "Consulta una categoría de productos con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: categoryId }) => {
    const [row] = await ctx.tx`select * from core.v_product_categories where id = ${categoryId}`;
    if (!row) throw new ProcessError("not_found", `category ${categoryId} not found`);
    return { ...row, id: categoryId, extra: await visibleExtra(ctx, "core.product_category", row.extra) };
  },
});

/** The stored columns as the create / update input, checked by the same schema (`""` is how a cleared optional code is stored: null). */
const asInput = (record: Record<string, unknown>) => ({
  name: record.name,
  ivaRate: record.iva_rate,
  incRate: record.inc_rate ?? null,
  otherTaxes: record.other_taxes ?? [],
  ...(record.default_uom ? { defaultUom: record.default_uom } : {}),
  ...(record.income_account ? { incomeAccount: record.income_account } : {}),
  isActive: record.is_active,
});

/**
 * The validate hook of core.product_category (Grabar, Aprobar): the record as stored after the step must pass the create / update
 * schema (name, IVA / INC rates, other taxes, unit, income account, Activo) and the custom fields. Products are never rewritten.
 */
export const categoryHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `core.category.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, CATEGORY_WRITABLE);
    const parsed = z.object(fields).omit({ extra: true, extraFree: true }).safeParse(asInput(record));
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    const custom = await customData(ctx, "core.product_category", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

/** The generic lifecycle processes of core.product_category; Grabar refuses a duplicate name (whatever its case). */
export const CATEGORY_LIFECYCLE = lifecycleProcesses(productCategory, "core.products", {
  duplicate: {
    constraint: NAME_KEY,
    detail: async (ctx, categoryId, data) => {
      const [stored] = await ctx.tx<{ name: string }[]>`select name from core.product_categories where id = ${categoryId}`;
      return duplicateDetail(String(data.name ?? stored?.name ?? ""));
    },
  },
});

export const CATEGORY_PROCESSES = [categoryCreate, categoryUpdate, categoryConsult, ...CATEGORY_LIFECYCLE];
