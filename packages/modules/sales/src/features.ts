import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { DELIVERY_PROCESSES } from "./processes/delivery";
import { ORDER_PROCESSES } from "./processes/order";
import { ORDER_OWNER_PROCESSES } from "./processes/order-owner";
import { RETURN_PROCESSES } from "./processes/return";
import { PRICING_PROCESSES } from "./processes/pricing";

// Features of the sales module (design §5.12, §8) and its menu. Labels are i18n keys. The level-1 items are the four sections (entity types
// spec §2.4, §9.2). Task 12 brings the pricing parameters: Condiciones comerciales (per customer: price list, discount, credit limit) and
// Parámetros de ventas (the default price list, the discount threshold of pedidos), both under Parámetros. Task 13 adds Pedidos under
// Documentos; Task 14 adds Entregas and Devoluciones beside it. The addresses are the pages of
// Task 14b. MENU_SHARED lists what no single screen owns: the price and discount resolution, which every line editor asks.

/** Processes no menu item guards (ModuleDef.menuShared). */
export const MENU_SHARED = ["sales.price.resolve", "sales.discount.resolve"];

export const NAVIGATION: NavItem[] = menuSections("sales", {
  documentos: [
    { id: "sales.orders", label: "nav.sales.orders", href: "/sales/orders", icon: "file-text", feature: "sales.orders", entity: "sales.order" },
    { id: "sales.deliveries", label: "nav.sales.deliveries", href: "/sales/deliveries", icon: "truck", feature: "sales.deliveries", entity: "sales.delivery" },
    { id: "sales.returns", label: "nav.sales.returns", href: "/sales/returns", icon: "undo-2", feature: "sales.returns", entity: "sales.return" },
  ],
  parametros: [
    { id: "sales.customer_terms", label: "nav.sales.customer_terms", href: "/sales/customer-terms", icon: "users", feature: "sales.pricing", entity: "sales.customer_terms" },
    { id: "sales.settings", label: "nav.sales.settings", href: "/sales/settings", icon: "sliders", feature: "sales.pricing", entity: "sales.settings" },
  ],
});

/** Items of the bar whose gate is `feature`. */
const nav = (feature: string) => NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

export const FEATURES: FeatureDef[] = [
  { id: "sales.pricing", label: "feature.sales.pricing", processes: PRICING_PROCESSES.map((p) => p.id), entities: ["sales.settings", "sales.customer_terms"], nav: nav("sales.pricing") },
  { id: "sales.orders", label: "feature.sales.orders", processes: [...ORDER_PROCESSES, ...ORDER_OWNER_PROCESSES].map((p) => p.id), entities: ["sales.order", "sales.order_line"], nav: nav("sales.orders") },
  { id: "sales.deliveries", label: "feature.sales.deliveries", processes: DELIVERY_PROCESSES.map((p) => p.id), entities: ["sales.delivery", "sales.delivery_line"], nav: nav("sales.deliveries") },
  { id: "sales.returns", label: "feature.sales.returns", processes: RETURN_PROCESSES.map((p) => p.id), entities: ["sales.return", "sales.return_line"], nav: nav("sales.returns") },
];
