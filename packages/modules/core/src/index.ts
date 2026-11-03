import { defineModule, type ModuleDef } from "@erp/kernel";
import { CORE_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION } from "./features";
import { HOME_KPIS } from "./home";
import { CATEGORY_PROCESSES, categoryHooks } from "./processes/category";
import { CONSULT_PROCESSES } from "./processes/consult";
import { CONTACT_PROCESSES } from "./processes/contact";
import { PARTY_PROCESSES, partyHooks } from "./processes/party";
import { PRICE_LIST_LIFECYCLE, priceListHooks } from "./processes/price-list";
import { PRODUCT_PROCESSES, productHooks } from "./processes/product";
import { SEQUENCE_PROCESSES } from "./processes/sequence";

/** The core module (design §8): parties and contacts, product categories and products, units, price lists and sequences. */
export const core: ModuleDef = defineModule({
  id: "core",
  version: "0.1.0",
  dependsOn: [],
  entities: CORE_ENTITIES,
  processes: [
    ...PARTY_PROCESSES,
    ...CONTACT_PROCESSES,
    ...CATEGORY_PROCESSES,
    ...PRODUCT_PROCESSES,
    ...SEQUENCE_PROCESSES,
    ...CONSULT_PROCESSES.parties,
    ...CONSULT_PROCESSES.products,
    ...PRICE_LIST_LIFECYCLE,
    ...CONSULT_PROCESSES.settings,
  ],
  features: FEATURES,
  events: { emits: ["core.party.created", "core.party.updated", "core.product.created", "core.product.updated"], consumes: {} },
  navigation: NAVIGATION,
  menuShared: MENU_SHARED,
  homeKpis: HOME_KPIS,
  // The maestros' validation at Grabar and Aprobar (entity types spec §5, Task 8a): the generic lifecycle processes and the update
  // processes run the same checks (country pack, DIAN status, party scope, custom fields, events).
  typedHooks: {
    "core.party": partyHooks,
    "core.product": productHooks,
    "core.product_category": categoryHooks,
    "core.price_list": priceListHooks,
  },
});

export { CORE_ENTITIES } from "./entities";
