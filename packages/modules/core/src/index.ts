import { defineModule, type ModuleDef } from "@erp/kernel";
import { CORE_ENTITIES } from "./entities";
import { FEATURES, NAVIGATION } from "./features";
import { CATEGORY_PROCESSES } from "./processes/category";
import { CONTACT_PROCESSES } from "./processes/contact";
import { PARTY_PROCESSES } from "./processes/party";
import { PRODUCT_PROCESSES } from "./processes/product";
import { SEQUENCE_PROCESSES } from "./processes/sequence";

/** The core module (design §8): parties and contacts, product categories and products, units, price lists and sequences. */
export const core: ModuleDef = defineModule({
  id: "core",
  version: "0.1.0",
  dependsOn: [],
  entities: CORE_ENTITIES,
  processes: [...PARTY_PROCESSES, ...CONTACT_PROCESSES, ...CATEGORY_PROCESSES, ...PRODUCT_PROCESSES, ...SEQUENCE_PROCESSES],
  features: FEATURES,
  events: { emits: ["core.party.created", "core.party.updated", "core.product.created", "core.product.updated"], consumes: {} },
  navigation: NAVIGATION,
});

export { CORE_ENTITIES } from "./entities";
