import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { defined } from "./common";
import { clearable, extra, id, incRate, ivaRate, otherTaxes, uomCode } from "./schemas";

// Product categories (design §5.18): a master whose taxes a product copies when it is assigned.
// Changing a category never rewrites the products that already use it.

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

const idOutput = z.object({ id: z.string() });

function columns(ctx: ProcessContext, input: CategoryFields) {
  const blank = (v: string | undefined) => (v === "" ? null : v);
  return {
    name: input.name,
    iva_rate: input.ivaRate,
    inc_rate: input.incRate,
    other_taxes: input.otherTaxes,
    default_uom: blank(input.defaultUom),
    income_account: blank(input.incomeAccount),
    status: input.status,
    extra: input.extra === undefined ? undefined : ctx.tx.json(input.extra as Parameters<typeof ctx.tx.json>[0]),
  };
}

const duplicate = (processId: string, name: string) =>
  new ProcessError("invalid_input", `duplicate category in ${processId}`, { details: [`Ya existe una categoría llamada ${name}`] });

export const categoryCreate = defineProcess({
  id: "core.category.create",
  module: "core",
  kind: "create",
  feature: "core.products",
  description: "Crea una categoría de productos con sus impuestos por defecto",
  input: z.object({ ...fields, otherTaxes: fields.otherTaxes.default([]), status: fields.status.default("active") }),
  output: idOutput,
  handler: async (ctx, input) => {
    const [inserted] = await ctx.tx<{ id: string }[]>`
      insert into core.product_categories ${ctx.tx({ company_id: ctx.companyId, ...defined(columns(ctx, input)) })}
      on conflict (company_id, name) do nothing
      returning id`;
    if (!inserted) throw duplicate("core.category.create", input.name);
    return { id: inserted.id };
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
    if (input.name !== undefined) {
      const clash = await ctx.tx`
        select 1 from core.product_categories where company_id = ${ctx.companyId} and name = ${input.name} and id <> ${categoryId}`;
      if (clash.length > 0) throw duplicate("core.category.update", input.name);
    }
    const set = defined(columns(ctx, input));
    if (Object.keys(set).length > 0) await ctx.tx`update core.product_categories set ${ctx.tx(set)} where id = ${categoryId}`;
    return { id: categoryId };
  },
});

export const categoryConsult = defineProcess({
  id: "core.category.consult",
  module: "core",
  kind: "consult",
  feature: "core.products",
  description: "Consulta una categoría de productos con los campos que el rol puede ver",
  input: z.object({ id }),
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: categoryId }) => {
    const [row] = await ctx.tx`select * from core.v_product_categories where id = ${categoryId}`;
    if (!row) throw new ProcessError("not_found", `category ${categoryId} not found`);
    return { ...row, id: categoryId };
  },
});

export const CATEGORY_PROCESSES = [categoryCreate, categoryUpdate, categoryConsult];
