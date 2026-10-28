import type { FeatureDef, NavItem } from "@erp/kernel";
import { CATEGORY_PROCESSES } from "./processes/category";
import { CONSULT_PROCESSES } from "./processes/consult";
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
  // Mass import of parties, products and categories (kernel.import.*): shown to whoever may import.
  { id: "core.import", label: "nav.core.import", href: "/import", icon: "upload", process: "kernel.import.run" },
];

const nav = (feature: string) => NAVIGATION.filter((item) => item.feature === feature);

export const FEATURES: FeatureDef[] = [
  {
    id: "core.parties",
    label: "feature.core.parties",
    processes: [...ids(PARTY_PROCESSES), ...ids(CONTACT_PROCESSES), ...ids(CONSULT_PROCESSES.parties)],
    entities: ["core.party", "core.party_contact"],
    nav: nav("core.parties"),
  },
  {
    id: "core.products",
    label: "feature.core.products",
    processes: [...ids(PRODUCT_PROCESSES), ...ids(CATEGORY_PROCESSES), ...ids(CONSULT_PROCESSES.products)],
    entities: ["core.product", "core.product_category", "core.uom", "core.price_list", "core.price_list_item"],
    nav: nav("core.products"),
  },
  {
    id: "core.settings",
    label: "feature.core.settings",
    processes: [...ids(SEQUENCE_PROCESSES), ...ids(CONSULT_PROCESSES.settings)],
    entities: ["core.document_sequence"],
  },
];
