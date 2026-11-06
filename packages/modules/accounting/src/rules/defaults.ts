import type { DefaultPostingRule } from "@erp/kernel";
import cogsPosted from "./defaults/cogs-posted.json" with { type: "json" };
import inventoryAdjustment from "./defaults/inventory-adjustment.json" with { type: "json" };
import invoiceIssued from "./defaults/invoice-issued.json" with { type: "json" };
import invoiceVoided from "./defaults/invoice-voided.json" with { type: "json" };
import noteAnnulmentIssued from "./defaults/note-annulment-issued.json" with { type: "json" };
import noteCreditIssued from "./defaults/note-credit-issued.json" with { type: "json" };
import noteDebitIssued from "./defaults/note-debit-issued.json" with { type: "json" };
import paymentReceived from "./defaults/payment-received.json" with { type: "json" };
import paymentVoided from "./defaults/payment-voided.json" with { type: "json" };

// The default rules of design §5.4. They live here, where they can be tested now; each phase 2B module moves its templates into its
// own manifest `postingRules` unchanged and drops them from this list (`accounting.posting_rule.sync` installs whatever the enabled
// modules ship, this list being the accounting module's own). Until those modules exist the seven stay here. A payload carries its document date as `date` (the engine reads it first to
// compare with the start of the ledger). `rules/fixtures/*.json` holds one sample payload per event. The note rule is three (plan 2B Task 18 fix
// round 1, migration 0098): one per kind of note, each with its `when`.
export const ACCOUNTING_DEFAULT_RULES = [
  invoiceIssued, noteAnnulmentIssued, noteCreditIssued, noteDebitIssued, invoiceVoided, cogsPosted, inventoryAdjustment, paymentReceived, paymentVoided,
] as unknown as DefaultPostingRule[];
