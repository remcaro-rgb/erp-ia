import { describe, expect, it } from "vitest";
import { kernelModule, ledgerOrStockReason, loadModules, Registry } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { inventory } from "@erp/module-inventory";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";

// Plan 2B Task 32, fix round 1 (security review I1): «posts to the ledger or moves stock» over the real registry. A nested run of any of these
// may never continue after a failure; a crm or core process that sets off nothing on the ledger or the stock may.

const registry = new Registry();
loadModules(registry, [kernelModule, core, support, accounting, inventory, costing, sales, crm, invoicing, payments]);

describe("ledgerOrStockReason over the loaded modules", () => {
  it("names the posting engine's, the stock's and the stock consumers' processes", () => {
    for (const id of [
      "accounting.entry.post_from_event", "accounting.posting.reverse_source", "accounting.posting_failure.record",
      "inventory.reservation.create", "inventory.reservation.release", "sales.delivery.record_stock",
    ]) {
      expect(() => registry.process(id), id).not.toThrow();
      expect(ledgerOrStockReason(registry, id), id).not.toBeNull();
    }
  });

  it("answers null for a crm or core process", () => {
    for (const id of ["crm.lead.create", "core.party.create"]) {
      expect(() => registry.process(id), id).not.toThrow();
      expect(ledgerOrStockReason(registry, id), id).toBeNull();
    }
  });
});
