import { defineModule, type ModuleDef } from "@erp/kernel";
import { SUPPORT_ENTITIES } from "./entities";
import { FEATURES, NAVIGATION } from "./features";
import { HOME_CHARTS, HOME_KPIS } from "./home";
import { TICKET_PROCESSES } from "./processes/ticket";

/** The support module (design §8): tickets filed with the context the client captured, and their conversation. */
export const support: ModuleDef = defineModule({
  id: "support",
  version: "0.1.0",
  // Core is the base module: the record number `seq` (rule 7) comes from its helper (migration 0017).
  dependsOn: ["core"],
  icon: "life-buoy",
  entities: SUPPORT_ENTITIES,
  processes: TICKET_PROCESSES,
  features: FEATURES,
  events: { emits: ["support.ticket.created"], consumes: {} },
  navigation: NAVIGATION,
  homeKpis: HOME_KPIS,
  homeCharts: HOME_CHARTS,
});

export { SUPPORT_ENTITIES } from "./entities";
export { ticketContext } from "./processes/ticket";
