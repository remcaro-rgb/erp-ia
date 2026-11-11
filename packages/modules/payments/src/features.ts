import { menuSections, type FeatureDef, type NavItem } from "@erp/kernel";
import { applicationEntity, applicationLineEntity, cashBoxEntity, methodEntity, receiptEntity, allocationEntity } from "./entities";
import { ADVANCE_PROCESSES } from "./processes/advance";
import { MASTER_PROCESSES, FEATURE_METHODS } from "./processes/masters";
import { FEATURE_RECEIPTS, RECEIPT_PROCESSES } from "./processes/receipt";

// Features of the payments module (design §8, plan 2B Task 21) and its menu. Labels are i18n keys. The level-1 items are the four sections
// (entity types spec §2.4, §9.2): Medios de pago and Cajas under Maestros, Recibos de caja under Documentos. Their pages are Task 24b's
// (apps/web/src/app/(app)/payments/*).

export const NAVIGATION: NavItem[] = menuSections("payments", {
  maestros: [
    { id: "payments.methods", label: "nav.payments.methods", href: "/payments/methods", icon: "credit-card", feature: FEATURE_METHODS, entity: methodEntity.id },
    { id: "payments.cash_boxes", label: "nav.payments.cash_boxes", href: "/payments/cash-boxes", icon: "archive", feature: FEATURE_METHODS, entity: cashBoxEntity.id },
  ],
  documentos: [
    // «Registrar pago» lists the customer's open invoices (payments.payment.open_invoices, Task 24b): the receipts' item guards it too.
    { id: "payments.receipts", label: "nav.payments.receipts", href: "/payments/receipts", icon: "receipt", feature: FEATURE_RECEIPTS, entity: receiptEntity.id, runs: ["payments.payment.open_invoices"] },
    // Aplicar anticipo a factura (plan 2B.2 Task 36): the applications of a customer's advance to invoices; «Aplicar a facturas» lists the open advances.
    { id: "payments.advance_applications", label: "nav.payments.advance_applications", href: "/payments/advance-applications", icon: "split", feature: FEATURE_RECEIPTS, entity: applicationEntity.id, runs: ["payments.advance.open"] },
  ],
});

/** Items of the bar whose gate is `feature`. */
const nav = (feature: string) => NAVIGATION.flatMap((item) => item.children ?? [item]).filter((item) => item.feature === feature);

export const FEATURES: FeatureDef[] = [
  { id: FEATURE_METHODS, label: "feature.payments.methods", processes: MASTER_PROCESSES.map((p) => p.id), entities: [methodEntity.id, cashBoxEntity.id], nav: nav(FEATURE_METHODS) },
  { id: FEATURE_RECEIPTS, label: "feature.payments.receipts", processes: [...RECEIPT_PROCESSES, ...ADVANCE_PROCESSES].map((p) => p.id), entities: [receiptEntity.id, allocationEntity.id, applicationEntity.id, applicationLineEntity.id], nav: nav(FEATURE_RECEIPTS) },
];
