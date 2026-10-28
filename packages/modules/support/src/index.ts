import { defineModule, type ModuleDef } from "@erp/kernel";
import { SUPPORT_ENTITIES } from "./entities";
import { FEATURES, NAVIGATION } from "./features";
import { TICKET_PROCESSES } from "./processes/ticket";

/** The support module (design §8): tickets filed with the context the client captured, and their conversation. */
export const support: ModuleDef = defineModule({
  id: "support",
  version: "0.1.0",
  dependsOn: [],
  entities: SUPPORT_ENTITIES,
  processes: TICKET_PROCESSES,
  features: FEATURES,
  events: { emits: ["support.ticket.created"], consumes: {} },
  navigation: NAVIGATION,
});

export { SUPPORT_ENTITIES } from "./entities";
export { ticketContext } from "./processes/ticket";
