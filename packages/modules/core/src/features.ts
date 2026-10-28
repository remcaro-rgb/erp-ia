import type { FeatureDef, NavItem } from "@erp/kernel";
import { CATEGORY_PROCESSES } from "./processes/category";
import { CONTACT_PROCESSES } from "./processes/contact";
import { PARTY_PROCESSES } from "./processes/party";
import { PRODUCT_PROCESSES } from "./processes/product";
import { SEQUENCE_PROCESSES } from "./processes/sequence";

// Features of the core module (design §5.12) and the menu items they unlock. Labels are i18n keys.

const ids = (processes: { id: string }[]) => processes.map((p) => p.id);

export const NAVIGATION: NavItem[] = [
  { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users", feature: "core.parties" },
  { id: "core.products", label: "nav.core.products", href: "/products", icon: "package", feature: "core.products" },
  { id: "core.categories", label: "nav.core.categories", href: "/categories", icon: "tags", feature: "core.products" },
];

const nav = (feature: string) => NAVIGATION.filter((item) => item.feature === feature);

export const FEATURES: FeatureDef[] = [
  {
    id: "core.parties",
    label: "feature.core.parties",
    processes: [...ids(PARTY_PROCESSES), ...ids(CONTACT_PROCESSES)],
    entities: ["core.party", "core.party_contact"],
    nav: nav("core.parties"),
  },
  {
    id: "core.products",
    label: "feature.core.products",
    processes: [...ids(PRODUCT_PROCESSES), ...ids(CATEGORY_PROCESSES)],
    entities: ["core.product", "core.product_category", "core.uom", "core.price_list"],
    nav: nav("core.products"),
  },
  {
    id: "core.settings",
    label: "feature.core.settings",
    processes: ids(SEQUENCE_PROCESSES),
    entities: [],
  },
];
