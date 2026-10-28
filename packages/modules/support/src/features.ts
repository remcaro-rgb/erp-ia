import type { FeatureDef, NavItem } from "@erp/kernel";
import { TICKET_PROCESSES } from "./processes/ticket";

// The feature of the support module (design §5.12) and the menu item it unlocks. Labels are i18n keys.

export const NAVIGATION: NavItem[] = [{ id: "support.tickets", label: "nav.support.tickets", href: "/support", icon: "life-buoy", feature: "support.tickets" }];

export const FEATURES: FeatureDef[] = [
  {
    id: "support.tickets",
    label: "feature.support.tickets",
    processes: TICKET_PROCESSES.map((p) => p.id),
    entities: ["support.ticket", "support.ticket_message"],
    nav: NAVIGATION,
  },
];
