import { describe, expect, it } from "vitest";
import { defineModule } from "../../module/define";
import type { DefaultPostingRule } from "../provider";

const mod = (rules: DefaultPostingRule[], accountRoles?: string[]) =>
  defineModule({ id: "probe", version: "0.0.1", dependsOn: [], entities: [], processes: [], features: [], events: { emits: [], consumes: {} }, navigation: [], postingRules: rules, accountRoles });
const rule = (role: string): DefaultPostingRule => ({ event: "probe.done", name: "r", journalCode: "NC", template: { description: "x", lines: [{ role, side: "debit", amount: "$.a" }] } });

describe("posting rules in a manifest", () => {
  it("accepts catalogue roles and roles the module declares", () => {
    expect(() => mod([rule("cash")])).not.toThrow();
    expect(() => mod([rule("tips")], ["tips"])).not.toThrow();
  });
  it("refuses an unknown role and an unparsable template", () => {
    expect(() => mod([rule("tips")])).toThrow(/tips/);
    expect(() => mod([{ ...rule("cash"), template: { description: "x", lines: [] } }])).toThrow(/invalid template/);
  });
});
