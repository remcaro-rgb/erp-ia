import type { DefaultPostingRule } from "@erp/kernel";
import inventoryAdjustment from "./defaults/inventory-adjustment.json" with { type: "json" };

// The default posting rules the inventory module ships (accounting design §5.4; `accounting.posting_rule.sync` installs them for a company
// that has inventory on, and switches them off with the module). `inventory-adjustment` (plan 2B Task 7, moved here from accounting's 2A
// defaults in Task 50.14, owner item 14): an adjustment movement with a value posts Dr inventory / Cr the adjustment account (role
// inventory_adjustment, on the cost center the movement carries), by its `when` on kind and value. `defaults/inventory-adjustment.fixture.json`
// is the sample payload of the event.
export const INVENTORY_POSTING_RULES: DefaultPostingRule[] = [inventoryAdjustment] as unknown as DefaultPostingRule[];
