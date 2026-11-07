import type { PostingMode } from "@erp/kernel";

// The posting mode's documentos (plan 2B Task 33, R33-4). The kernel derives the contabiliza documentos from the registry
// (`inlinePostingProcesses`: processes that emit an event a module's posting rules post); these processes emit such events too, but post through
// the accounting consumer by design and never through emitAndPostStrict, so the posting mode does not apply to them. Each one says why.

export const ASYNC_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  ["inventory.movement.post", "a stock movement (receipt, issue, adjustment) emits inventory.movement.posted, which the accounting consumer posts; it never posts inline"],
  ["inventory.transfer.ship", "a transfer's shipment emits inventory.movement.posted for the accounting consumer, as every stock movement"],
  ["inventory.transfer.receive", "a transfer's receipt emits inventory.movement.posted for the accounting consumer, as every stock movement"],
  ["inventory.adjustment.post", "an inventory adjustment emits inventory.movement.posted, posted by the accounting consumer (a closed period is a retryable pending, OD-4)"],
  ["inventory.count.apply", "applying a physical count emits inventory.movement.posted for the accounting consumer, as every stock movement"],
  ["inventory.sale.issue", "the stock issue of a delivery (an event consumer) emits inventory.movement.posted for the accounting consumer (OD-4)"],
  ["inventory.sale.return", "the stock return of a sales return (an event consumer) emits inventory.movement.posted for the accounting consumer"],
  ["costing.movement.cost", "the cost of sales of a movement (an event consumer) emits costing.cogs.posted or costing.cogs.returned, posted by the accounting consumer"],
  ["costing.movement.void_cost", "the void of a movement's cost (an event consumer) emits costing.cogs.voided or costing.cogs.return_voided, posted by the accounting consumer"],
]);

/** The two modes, the default first (the kernel's `PostingMode`). */
export const POSTING_MODES = ["inline_strict", "asynchronous"] as const satisfies readonly PostingMode[];
