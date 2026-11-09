import { defineProcess, ProcessError, visibleExtra } from "@erp/kernel";
import { z } from "zod";
import { idInput } from "./common";

// The consult processes of the core entities that had none (design §9, rule 13): reading an entity — its record or
// its grid — needs the entity's own consult permission. Each reads one row of the entity's masked view as the caller,
// so company RLS, the party scope (contacts) and field masking apply.

function consultOf(entityId: string, view: string, feature: string, description: string, withExtra: boolean) {
  return defineProcess({
    id: `${entityId}.consult`,
    module: "core",
    kind: "consult",
    feature,
    description,
    input: idInput,
    output: z.looseObject({ id: z.string() }),
    handler: async (ctx, { id }) => {
      const [row] = await ctx.tx`select * from ${ctx.tx(view)} where id = ${id}`;
      if (!row) throw new ProcessError("not_found", `${entityId} ${id} not found`);
      return withExtra ? { ...row, id, extra: await visibleExtra(ctx, entityId, row.extra) } : { ...row, id };
    },
  });
}

export const uomConsult = consultOf("core.uom", "core.v_uoms", "core.products", "Consulta una unidad de medida", false);
export const priceListConsult = consultOf("core.price_list", "core.v_price_lists", "core.products", "Consulta una lista de precios con los campos que el rol puede ver", true);
export const priceListItemConsult = consultOf(
  "core.price_list_item",
  "core.v_price_list_items",
  "core.products",
  "Consulta un precio de una lista de precios con los campos que el rol puede ver",
  true,
);
export const partyContactConsult = consultOf("core.party_contact", "core.v_party_contacts", "core.parties", "Consulta un contacto de un tercero con los campos que el rol puede ver", true);
export const documentSequenceConsult = consultOf(
  "core.document_sequence",
  "core.v_document_sequences",
  "core.settings",
  "Consulta una numeración de documentos con los campos que el rol puede ver",
  true,
);

// Tasas de cambio and the import log (plan 2B.2 Task 34.1, migration 0147).
export const exchangeRateConsult = consultOf("core.exchange_rate", "core.v_exchange_rates", "core.settings", "Consulta una tasa de cambio de un día con los campos que el rol puede ver", true);
export const exchangeRateImportConsult = consultOf(
  "core.exchange_rate_import",
  "core.v_exchange_rate_imports",
  "core.settings",
  "Consulta lo que hizo la importación de la tasa oficial en un día (importada o fallida, intentos y error)",
  true,
);

/** By feature, so the manifest lists each in its feature. */
export const CONSULT_PROCESSES = {
  parties: [partyContactConsult],
  products: [uomConsult, priceListConsult, priceListItemConsult],
  settings: [documentSequenceConsult, exchangeRateConsult, exchangeRateImportConsult],
};
