import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { CATEGORY_PROCESSES } from "./processes/category";
import { CONSULT_PROCESSES } from "./processes/consult";
import { CONTACT_PROCESSES } from "./processes/contact";
import { PARTY_PROCESSES } from "./processes/party";
import { PRICE_LIST_LIFECYCLE } from "./processes/price-list";
import { PRODUCT_PROCESSES } from "./processes/product";
import { SEQUENCE_PROCESSES } from "./processes/sequence";

// Features of the core module (design §5.12) and the menu items they unlock. Labels are i18n keys. The menu's level-1 items are the four
// sections (entity types spec §2.4): Terceros, Productos and Categorías name their maestro and the loader places them under Maestros;
// Documentos, Reportes and Parámetros are empty for now (the shell shows their empty state).

const ids = (processes: { id: string }[]) => processes.map((p) => p.id);

export const NAVIGATION: NavItem[] = [
  ...menuSections("core"),
  { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users", feature: "core.parties", entity: "core.party", runs: ["core.contact."] },
  { id: "core.products", label: "nav.core.products", href: "/products", icon: "package", feature: "core.products", entity: "core.product" },
  { id: "core.categories", label: "nav.core.categories", href: "/categories", icon: "tags", feature: "core.products", entity: "core.product_category", runs: ["core.category."] },
  // Mass import of parties, products and categories (kernel.import.*): shown to whoever may import. The import is the kernel's, shared by
  // every grid: hiding this item hides this page only; an import into an entity whose item is hidden is refused through its create process.
  { id: "core.import", label: "nav.core.import", href: "/import", icon: "upload", process: "kernel.import.run" },
];

/**
 * Processes no menu item guards (ModuleDef.menuShared): numbering and the units every product screen reads, and the price lists, which
 * have no screen yet (their item will guard them). core.document_sequence.register (plan 2B Task 19) is run from invoicing's Parámetros de
 * facturación page, whose menu item names it.
 */
export const MENU_SHARED = ["core.sequence.next", "core.document_sequence.consult", "core.document_sequence.register", "core.uom.consult", "core.price_list.", "core.price_list_item."];

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
    processes: [...ids(PRODUCT_PROCESSES), ...ids(CATEGORY_PROCESSES), ...ids(CONSULT_PROCESSES.products), ...ids(PRICE_LIST_LIFECYCLE)],
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
