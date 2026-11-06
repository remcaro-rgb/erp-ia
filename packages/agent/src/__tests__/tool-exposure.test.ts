import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { inventory } from "@erp/module-inventory";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";
import { agentCandidates, EXCLUDED_PROCESSES } from "../tools/from-registry";

// Which registered processes the assistant may ever be offered (rules 1 and 17, plan 2B Task 25): derived from the registry, never from a
// hand list. A process restricted to other origins (an event consumer's, a screen's), one that runs only nested inside another, and one
// the agent excludes for a reason (a file, a sign-out, an unmasked read) is never a tool, for every module of the sales chain. The role
// matrix and the company's entitlements narrow the rest per caller (tools.integration.test.ts, sales-tools.integration.test.ts).

const registry = new Registry();
loadModules(registry, [kernelModule, core, support, accounting, inventory, costing, sales, crm, invoicing, payments]);
const CHAIN = ["crm", "sales", "inventory", "costing", "invoicing", "payments"];
const offered = new Set(agentCandidates(registry).map((p) => p.id));

describe("the assistant's tool candidates", () => {
  it("leave out every process whose origins exclude the agent and every nested-only one, in every 2B module (derived from the registry)", () => {
    const chain = registry.processes().filter((p) => CHAIN.includes(p.module));
    const restricted = new Set(chain.filter((p) => (p.origins && !p.origins.includes("agent")) || p.nestedOnlyFrom).map((p) => p.id));
    // Derived here from the process definitions, independently of the filter: restricted or excluded is never offered, the rest always is
    // (the role matrix decides per caller).
    for (const p of chain) expect(offered.has(p.id), p.id).toBe(!restricted.has(p.id) && !EXCLUDED_PROCESSES.has(p.id));
  });

  it("an explicit denylist: event-only handlers, the nested annulment note, the screen-only uploads and the unmasked consult are never tools", () => {
    const never = [
      // Event-only (origins: event): the DIAN verdict, what the receipts paid, what was invoiced, the costing of a movement, the PDF…
      "invoicing.invoice.dian_result", "invoicing.note.dian_result", "invoicing.invoice.record_payments", "invoicing.invoice.auto_create", "invoicing.invoice.recommend",
      "invoicing.einvoice_submission.request", "invoicing.einvoice_submission.record", "invoicing.einvoice_submission.document", "invoicing.einvoice_submission.store_pdf",
      "sales.delivery.record_invoiced", "sales.delivery.record_stock", "sales.delivery.reopen", "sales.return.restore",
      "inventory.sale.issue", "inventory.sale.void_issue", "inventory.sale.return", "inventory.sale.void_return",
      "costing.movement.cost", "costing.movement.void_cost", "crm.opportunity.mark_won",
      "accounting.entry.post_from_event", "accounting.posting_failure.record", "accounting.posting_rule.sync", "accounting.posting.reverse_source",
      // Nested only (inside invoicing.invoice.void, whose step-up covers it).
      "invoicing.note.issue_annulment",
      // Screen only (origins: ui): the certificate, the software PIN and the DIAN resolution (its technical key) never travel through the chat.
      "invoicing.certificate.upload", "invoicing.software_pin.set", "core.document_sequence.register",
      // Reads invoicing's unmasked published view (rule 17: the assistant reads invoices through the masked invoicing.invoice).
      "payments.payment.open_invoices",
    ];
    for (const id of never) {
      expect(() => registry.process(id), id).not.toThrow();
      expect(offered.has(id), id).toBe(false);
    }
  });

  it("offers the sales chain's writes, step-up ones included (their card asks for the code)", () => {
    for (const id of [
      "crm.quote.create", "sales.order.confirm", "sales.delivery.ship", "invoicing.invoice.from_orders", "invoicing.invoice.issue", "payments.payment.receive",
      "invoicing.invoice.void", "payments.payment.void", "inventory.adjustment.post", "invoicing.settings.update",
    ]) {
      expect(offered.has(id), id).toBe(true);
    }
    for (const id of ["invoicing.invoice.void", "payments.payment.void", "inventory.adjustment.post"]) expect(registry.process(id).sensitivity, id).toBe("step-up");
  });

  it("every exclusion names a registered process and says why", () => {
    for (const [id, reason] of EXCLUDED_PROCESSES) {
      expect(registry.processes().some((p) => p.id === id), id).toBe(true);
      expect(reason.length, id).toBeGreaterThan(10);
    }
  });
});
