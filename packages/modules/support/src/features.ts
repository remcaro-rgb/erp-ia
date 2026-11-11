import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { TICKET_PROCESSES } from "./processes/ticket";

// The feature of the support module (design §5.12) and the menu item it unlocks. Labels are i18n keys. The four menu sections
// (entity types spec §2.4) are empty: tickets are `sistema` records (D13) and Soporte stays a level-1 item of its own.

const TICKETS: NavItem = { id: "support.tickets", label: "nav.support.tickets", href: "/support", icon: "life-buoy", feature: "support.tickets", entity: "support.ticket", runs: ["support.ticket_message."] };

export const NAVIGATION: NavItem[] = [...menuSections("support"), TICKETS];

export const FEATURES: FeatureDef[] = [
  {
    id: "support.tickets",
    label: "feature.support.tickets",
    processes: TICKET_PROCESSES.map((p) => p.id),
    entities: ["support.ticket", "support.ticket_message"],
    nav: [TICKETS],
  },
];
