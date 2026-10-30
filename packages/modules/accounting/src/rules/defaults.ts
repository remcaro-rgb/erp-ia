import type { DefaultPostingRule } from "@erp/kernel";
import cogsPosted from "./defaults/cogs-posted.json" with { type: "json" };
import inventoryAdjustment from "./defaults/inventory-adjustment.json" with { type: "json" };
import invoiceIssued from "./defaults/invoice-issued.json" with { type: "json" };
import invoiceVoided from "./defaults/invoice-voided.json" with { type: "json" };
import noteIssued from "./defaults/note-issued.json" with { type: "json" };
import paymentReceived from "./defaults/payment-received.json" with { type: "json" };
import paymentVoided from "./defaults/payment-voided.json" with { type: "json" };

// The default rules of design §5.4. They live here, where they can be tested now; the phase 2B modules move each template into
// their own manifest `postingRules` unchanged. A payload carries its document date as `date` (the engine reads it first to
// compare with the start of the ledger). `rules/fixtures/*.json` holds one sample payload per event.
export const ACCOUNTING_DEFAULT_RULES = [
  invoiceIssued, noteIssued, invoiceVoided, cogsPosted, inventoryAdjustment, paymentReceived, paymentVoided,
] as unknown as DefaultPostingRule[];
