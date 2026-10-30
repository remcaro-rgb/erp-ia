import type { EventRef } from "../compose";
import type { RuleTemplate } from "../template";

export const invoicePayload = {
  number: "FE-1",
  invoiceId: "inv-1",
  issuedAt: "2026-10-30",
  dueDate: "2026-11-30",
  customer: { partyId: "party-1", legalName: "Tiendas D1 S.A.S." },
  totals: { total: 119000 },
  lines: [
    { subtotal: 50000, categoryId: "bebidas" },
    { subtotal: 50000, categoryId: "comida" },
  ],
  taxes: [{ code: "01", amount: 19000, base: 100000 }],
};

export const invoiceEvent: EventRef = {
  id: "evt-1",
  event: "invoicing.invoice.issued",
  payload: invoicePayload,
  createdAt: new Date("2026-10-30T15:00:00Z"),
  chainId: "chain-1",
};

export const invoiceTemplate: RuleTemplate = {
  date: "$.issuedAt",
  description: "Factura {{number}} · {{customer.legalName}}",
  party: "$.customer.partyId",
  source: { entity: "invoicing.invoice", id: "$.invoiceId" },
  lines: [
    { role: "receivable", side: "debit", amount: "$.totals.total", dueDate: "$.dueDate" },
    { role: "revenue", side: "credit", forEach: "$.lines[*]", amount: "$.subtotal", dimension: "category:{{categoryId}}" },
    { role: "vat_out", side: "credit", forEach: "$.taxes[*]", amount: "$.amount", dimension: "tax:{{code}}", taxCode: "$.code", taxBase: "$.base" },
  ],
  reverseOf: null,
};
