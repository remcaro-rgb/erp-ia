import { defineProcess, ProcessError, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { defined, idOutput, refuseDuplicate, rejectErrors } from "./common";
import { initialLifecycle } from "./lifecycle";
import { id } from "./schemas";

// Price list writes (plan 2B Task 51, item 55): the three processes that create a list and set or remove one product's price in it.
// The list's name and currency of an existing list are edited with the generic Grabar (core.price_list.save, R51-1); item.set is the
// only item write. A price list is a maestro (created Grabado, or Pendiente de Aprobación when the company requires it); its items are
// its lines. Rule 10: invoice_ready is for document lines, so a priced product only has to be usable (kernel.record_usable).

/** Unique constraint on (company_id, name): shared with the generic Grabar (price-list.ts). */
const NAME_KEY = "price_lists_company_id_name_key";

const currencyCode = z.string().regex(/^[A-Z]{3}$/, "La moneda debe ser un código ISO 4217 de tres letras, p. ej. COP");

/** A price in the list's currency: not negative, at most two decimals. */
const price = z
  .number()
  .min(0, "El precio no puede ser negativo")
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "El precio admite como máximo dos decimales");

export const priceListCreate = defineProcess({
  id: "core.price_list.create",
  module: "core",
  kind: "create",
  feature: "core.products",
  recordAccess: "none",
  description: "Crea una lista de precios con su nombre y su moneda (ISO 4217, p. ej. COP); los precios por producto se fijan después",
  input: z.object({ name: z.string().trim().min(1, "Indica el nombre de la lista de precios"), currencyCode }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const [currency] = await ctx.tx`select 1 from core.currencies where code = ${input.currencyCode}`;
    if (!currency) rejectErrors("core.price_list.create", [`La moneda ${input.currencyCode} no existe`]);
    const values = { company_id: ctx.companyId, ...(await initialLifecycle(ctx, "core.price_list")), name: input.name, currency_code: input.currencyCode };
    const [inserted] = await refuseDuplicate("core.price_list.create", NAME_KEY, `Ya existe una lista de precios llamada ${input.name}`, () =>
      ctx.tx<{ id: string }[]>`insert into core.price_lists ${ctx.tx(values)} returning id`,
    );
    return { id: inserted!.id };
  },
});

/**
 * The list a price is written in, locked: visible to the caller, not deleted, active and not waiting for approval (a list under review
 * does not change under its approver). Refused as invalid_input otherwise.
 */
async function writableList(ctx: ProcessContext, processId: string, listId: string): Promise<void> {
  const [row] = await ctx.tx<{ is_active: boolean; status: string; deleted_at: Date | null }[]>`
    select p.is_active, p.status, p.deleted_at from core.v_price_lists v join core.price_lists p on p.id = v.id where v.id = ${listId} for update of p`;
  if (!row || row.deleted_at) rejectErrors(processId, ["La lista de precios no existe"]);
  rejectErrors(processId, [
    ...(row!.is_active ? [] : ["La lista de precios está inactiva"]),
    ...(row!.status === "pending" ? ["La lista de precios espera aprobación y no se puede modificar"] : []),
  ]);
}

export const priceListItemSet = defineProcess({
  id: "core.price_list_item.set",
  module: "core",
  kind: "update",
  feature: "core.products",
  recordAccess: { entity: "core.price_list", idField: "priceListId", right: "modify" },
  description: "Fija el precio de un producto en una lista de precios (lo crea o lo cambia); el precio no puede ser negativo y admite dos decimales",
  input: z.object({ priceListId: id, productId: id, price }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    await writableList(ctx, "core.price_list_item.set", input.priceListId);
    const [product] = await ctx.tx<{ usable: boolean }[]>`select kernel.record_usable('core.product', id) as usable from core.v_products where id = ${input.productId}`;
    if (!product) rejectErrors("core.price_list_item.set", ["El producto no existe o no es visible"]);
    if (!product!.usable) rejectErrors("core.price_list_item.set", ["El producto no está activo, grabado o aprobado"]);
    const [current] = await ctx.tx<{ id: string }[]>`
      select id from core.price_list_items where price_list_id = ${input.priceListId} and product_id = ${input.productId} for update`;
    if (current) {
      await ctx.tx`update core.price_list_items set price = ${input.price} where id = ${current.id}`;
      return { id: current.id };
    }
    const values = defined({ company_id: ctx.companyId, price_list_id: input.priceListId, product_id: input.productId, price: input.price });
    const [inserted] = await ctx.tx<{ id: string }[]>`insert into core.price_list_items ${ctx.tx(values)} returning id`;
    return { id: inserted!.id };
  },
});

export const priceListItemRemove = defineProcess({
  id: "core.price_list_item.remove",
  module: "core",
  kind: "delete",
  feature: "core.products",
  recordAccess: { entity: "core.price_list", idField: "priceListId", right: "modify" },
  description: "Quita el precio de un producto de una lista de precios; el producto vuelve a tomar el precio de la lista predeterminada o su precio de lista",
  input: z.object({ priceListId: id, productId: id }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    await writableList(ctx, "core.price_list_item.remove", input.priceListId);
    const rows = await ctx.tx<{ id: string }[]>`
      delete from core.price_list_items where price_list_id = ${input.priceListId} and product_id = ${input.productId} returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `product ${input.productId} has no price in list ${input.priceListId}`);
    return { id: rows[0]!.id };
  },
});

export const PRICE_LIST_WRITE_PROCESSES = [priceListCreate, priceListItemSet, priceListItemRemove];
