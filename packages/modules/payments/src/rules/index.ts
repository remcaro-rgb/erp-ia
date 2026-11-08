import type { DefaultPostingRule } from "@erp/kernel";
import paymentReceived from "./payment-received.json" with { type: "json" };
import paymentVoided from "./payment-voided.json" with { type: "json" };
import advanceApplied from "./advance-applied.json" with { type: "json" };
import advanceUnapplied from "./advance-unapplied.json" with { type: "json" };

// The posting rules the payments module ships (accounting design §5.4; `accounting.posting_rule.sync` installs them for a company that has
// payments on). `payment-received`: Dr cash (the account of the method: role cash, dimension payment_method:<code>; the pack maps
// transferencia and tarjeta to the bank) / Dr withholdings suffered, one line per withholding the customer practised with its code, rate and
// base / Cr receivable (what the receipt applied to invoices) / Cr customer_advances (what it did not apply: an anticipo, plan 2B Task 21).
// The advance line iterates `$.advances[*]` so the 2A fixture (no advance) composes exactly as before. `payment-voided` reverses the entry
// of the receipt (`reverseOf`, found by its source: the receipt). `advance-applied` (plan 2B.2 Task 36, R36-2): Dr customer_advances / Cr receivable
// for the whole total of an application of an advance to invoices, the customer as party, the application as source (one receivable credit line,
// which accounting's open items split over the invoices exactly as for a receipt); `advance-unapplied` reverses it (`reverseOf`). They are the same rules (same event and name) as accounting's defaults,
// byte for byte, so a company keeps one copy of each: the sync matches (event, name) and never adds one twice (as invoicing, Task 16).
export const PAYMENTS_POSTING_RULES: DefaultPostingRule[] = [paymentReceived, paymentVoided, advanceApplied, advanceUnapplied] as DefaultPostingRule[];
