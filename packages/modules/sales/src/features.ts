import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { DELIVERY_PROCESSES } from "./processes/delivery";
import { ORDER_PROCESSES } from "./processes/order";
import { ORDER_OWNER_PROCESSES } from "./processes/order-owner";
import { RETURN_PROCESSES } from "./processes/return";
import { PRICING_PROCESSES } from "./processes/pricing";
import { COMMISSION_PLAN_PROCESSES } from "./processes/commission-plan";
import { COMMISSION_PROCESSES } from "./processes/commission";
import { SALES_REPORT_PROCESSES } from "./reports/commissions";

// Features of the sales module (design §5.12, §8) and its menu. Labels are i18n keys. The level-1 items are the four sections (entity types
// spec §2.4, §9.2). Task 12 brings the pricing parameters: Condiciones comerciales (per customer: price list, discount, credit limit) and
// Parámetros de ventas (the default price list, the discount threshold of pedidos), both under Parámetros. Task 13 adds Pedidos under
// Documentos; Task 14 adds Entregas and Devoluciones beside it. The addresses are the pages of
// Task 14b. Task 30.1 adds Planes de comisión under Maestros; Task 30.4 Comisiones under Documentos and Comisiones por vendedor under Reportes. MENU_SHARED lists what no single screen owns: the price and discount resolution, which every line editor asks.

/** Processes no menu item guards (ModuleDef.menuShared). */
export const MENU_SHARED = ["sales.price.resolve", "sales.discount.resolve"];

export const NAVIGATION: NavItem[] = menuSections("sales", {
  // Plan 2B.2 Task 30.1 (PG §5.5): the commission plans (who earns, at what rate, on whose pedidos).
  maestros: [
    { id: "sales.commission_plans", label: "nav.sales.commission_plans", href: "/sales/commission-plans", icon: "percent", feature: "sales.commissions", entity: "sales.commission_plan" },
  ],
  documentos: [
    { id: "sales.orders", label: "nav.sales.orders", href: "/sales/orders", icon: "file-text", feature: "sales.orders", entity: "sales.order" },
    { id: "sales.deliveries", label: "nav.sales.deliveries", href: "/sales/deliveries", icon: "truck", feature: "sales.deliveries", entity: "sales.delivery" },
    { id: "sales.returns", label: "nav.sales.returns", href: "/sales/returns", icon: "undo-2", feature: "sales.returns", entity: "sales.return" },
    // Task 30.4 (PG §5.5): the commission documents (COM-), written only by their events; the item guards every commission process.
    { id: "sales.commissions", label: "nav.sales.commissions", href: "/sales/commissions", icon: "coins", feature: "sales.commissions", entity: "sales.commission", runs: ["sales.commission."] },
  ],
  // Task 30.4: «Comisiones por vendedor», by payee, period and status (sales.report.commissions).
  reportes: [
    { id: "sales.commission_report", label: "nav.sales.commission_report", href: "/sales/reports/commissions", icon: "file-bar-chart", feature: "sales.commissions", runs: ["sales.report.commissions"] },
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
  // Commissions (plan 2B.2 Task 30.1): the plans, the bases an issued invoice writes and the commission documents (Tasks 30.2–30.4).
  {
    id: "sales.commissions",
    label: "feature.sales.commissions",
    processes: [...COMMISSION_PLAN_PROCESSES, ...COMMISSION_PROCESSES, ...SALES_REPORT_PROCESSES].map((p) => p.id),
    entities: ["sales.commission_plan", "sales.commission_base", "sales.commission", "sales.commission_line"],
    nav: nav("sales.commissions"),
  },
];
