import { describe, expect, it } from "vitest";
import { kernelModule } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { inventory } from "@erp/module-inventory";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { warehouse } from "@erp/module-warehouse";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";

// Plan 2B Task 50.3 (owner item 3): a module that subscribes to an event does something when it fires, and a confirmation card must say so.
// Every `events.consumes` key (except the posting catch-all "*" and the kernel's own events) therefore has a non-empty `effects` line.

/** The only way out: an event a module consumes without a line for the card, with the reason. None expected. */
export const EFFECTS_EXEMPT: Record<string, string> = {};

const modules = [kernelModule, core, accounting, inventory, costing, sales, crm, invoicing, payments, support, warehouse];

describe("every subscribed event has an effect line (plan 2B Task 50.3)", () => {
  it("each consumed event, but '*' and kernel.*, has a non-empty effects entry or a reasoned exemption", () => {
    const missing: string[] = [];
    for (const module of modules) {
      for (const event of Object.keys(module.events.consumes)) {
        if (event === "*" || event.startsWith("kernel.")) continue;
        const key = `${module.id}:${event}`;
        if (EFFECTS_EXEMPT[key] !== undefined) continue;
        if ((module.effects?.[event] ?? []).length === 0) missing.push(key);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every exemption states its reason", () => {
    for (const [key, reason] of Object.entries(EFFECTS_EXEMPT)) expect(reason.trim(), key).not.toBe("");
  });
});
