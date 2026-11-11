import { customData, type TypedHooks } from "@erp/kernel";
import { priceList } from "../entities";
import { rejectErrors } from "./common";
import { assertWritable, lifecycleProcesses, writableColumns } from "./lifecycle";

// Price lists (design §5.18): a maestro (entity types spec §2.2) with no create or update process of its own yet; the generic
// lifecycle processes are its only writes, and the validate hook keeps the stored record sound (Task 8a).

/** What the generic Grabar may write (no update process yet): its name, currency, Activo and extra data. */
const PRICE_LIST_WRITABLE = writableColumns({ name: true, currencyCode: true, extra: true, extraFree: true });

/** Unique constraint on (company_id, name). */
const NAME_KEY = "price_lists_company_id_name_key";

/** The validate hook of core.price_list (Grabar, Aprobar): a name, an ISO 4217 currency code and valid extra data. */
export const priceListHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `core.price_list.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, PRICE_LIST_WRITABLE);
    const errors: string[] = [];
    if (typeof record.name !== "string" || record.name.trim() === "") errors.push("Indica el nombre de la lista de precios");
    if (typeof record.currency_code !== "string" || !/^[A-Z]{3}$/.test(record.currency_code)) errors.push("La moneda debe ser un código ISO 4217 de tres letras, p. ej. COP");
    rejectErrors(processId, errors);
    const custom = await customData(ctx, "core.price_list", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

/** The generic lifecycle processes of core.price_list; Grabar refuses a duplicate name. */
export const PRICE_LIST_LIFECYCLE = lifecycleProcesses(priceList, "core.products", {
  duplicate: {
    constraint: NAME_KEY,
    detail: async (ctx, listId, data) => {
      const [stored] = await ctx.tx<{ name: string }[]>`select name from core.price_lists where id = ${listId}`;
      return `Ya existe una lista de precios llamada ${String(data.name ?? stored?.name ?? "")}`;
    },
  },
});
