import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { blank, defined, idInput, idOutput, jsonb, refuseDuplicate } from "./common";
import { clearable, extra, id, incRate, ivaRate, otherTaxes, uomCode } from "./schemas";

// Product categories (design §5.18): a master whose taxes a product copies when it is assigned.
// Changing a category never rewrites the products that already use it. Names are unique per company
// without regard to case (unique index on lower(name)).

const fields = {
  name: z.string().trim().min(1).max(100),
  ivaRate,
  incRate: incRate.nullable().optional(),
  otherTaxes,
  defaultUom: clearable(uomCode).optional(),
  incomeAccount: clearable(z.string().trim().max(20)).optional(),
  status: z.enum(["active", "inactive"]),
  extra,
};
type CategoryFields = Partial<z.output<z.ZodObject<typeof fields>>>;

/** Unique index on (company_id, lower(name)). */
const NAME_KEY = "product_categories_company_name_key";

function columns(ctx: ProcessContext, input: CategoryFields) {
  return {
    name: input.name,
    iva_rate: input.ivaRate,
    inc_rate: input.incRate,
    other_taxes: input.otherTaxes,
    default_uom: blank(input.defaultUom),
    income_account: blank(input.incomeAccount),
    status: input.status,
    extra: jsonb(ctx, input.extra),
  };
}

const duplicateDetail = (name: string) => `Ya existe una categoría llamada ${name}`;

export const categoryCreate = defineProcess({
  id: "core.category.create",
  module: "core",
  kind: "create",
  feature: "core.products",
  description: "Crea una categoría de productos con sus impuestos por defecto",
  input: z.object({ ...fields, otherTaxes: fields.otherTaxes.default([]), status: fields.status.default("active") }),
  output: idOutput,
  handler: async (ctx, input) => {
    const [inserted] = await refuseDuplicate(
      "core.category.create",
      NAME_KEY,
      duplicateDetail(input.name),
      () => ctx.tx<{ id: string }[]>`
        insert into core.product_categories ${ctx.tx({ company_id: ctx.companyId, ...defined(columns(ctx, input)) })}
        returning id`,
    );
    return { id: inserted!.id };
  },
});

export const categoryUpdate = defineProcess({
  id: "core.category.update",
  module: "core",
  kind: "update",
  feature: "core.products",
  description: "Actualiza una categoría de productos; los productos existentes no cambian",
  input: z.object(fields).partial().extend({ id }),
  output: idOutput,
  handler: async (ctx, { id: categoryId, ...input }) => {
    const [current] = await ctx.tx`select 1 from core.product_categories where id = ${categoryId} for update`;
    if (!current) throw new ProcessError("not_found", `category ${categoryId} not found`);
    const set = defined(columns(ctx, input));
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("core.category.update", NAME_KEY, duplicateDetail(input.name ?? ""), () =>
        ctx.tx`update core.product_categories set ${ctx.tx(set)} where id = ${categoryId}`,
      );
    }
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
    return { ...row, id: categoryId };
  },
});

export const CATEGORY_PROCESSES = [categoryCreate, categoryUpdate, categoryConsult];
