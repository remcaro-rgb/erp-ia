import type { DefaultPostingRule } from "@erp/kernel";
import invoiceIssued from "./invoice-issued.json" with { type: "json" };
import noteAnnulmentIssued from "./note-annulment-issued.json" with { type: "json" };
import noteCreditIssued from "./note-credit-issued.json" with { type: "json" };
import noteDebitIssued from "./note-debit-issued.json" with { type: "json" };

// The posting rules the invoicing module ships (accounting design §5.4; `accounting.posting_rule.sync` installs them for a company that has
// invoicing on). `invoice-issued`: Dr receivable (the total, due on the invoice's due date) / Cr revenue per line (the category's mapping,
// else the role's; the cost center the demo chart's 4135 asks for) / Cr vat_out per tax and rate (the ledger's code). The note (Task 18):
// the same sides with its amounts signed (a credit note's are negative, so its entry reverses the invoice's), one rule per kind by its
// `when` (fix round 1, migration 0098): the annulment and a debit note post revenue by category, the exact mirror of the invoice; a partial
// credit posts to sales returns by its concept (`note_reason:<code>`, else the role's 417505). They are the same rules (same event and name)
// as accounting's defaults, so a company keeps one copy of each: the sync matches (event, name) and never adds one twice (plan 2B Task 16).
// The annulment posts through the credit note of annulment (OD-7): no `invoice-voided` here, and invoicing.invoice.voided is never emitted
// (accounting's default reverseOf rule for it stays unused).
export const INVOICING_POSTING_RULES: DefaultPostingRule[] = [invoiceIssued, noteAnnulmentIssued, noteCreditIssued, noteDebitIssued] as DefaultPostingRule[];
