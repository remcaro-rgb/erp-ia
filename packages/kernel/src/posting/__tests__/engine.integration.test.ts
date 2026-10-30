import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { JwtClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { postingConsumer } from "../engine";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { ProcessError } from "../../process/errors";
import { defineProcess } from "../../process/define";
import { runProcess } from "../../process/run";
import { Registry } from "../../registry";
import { registerCountryPack, type CountryPack } from "../../localization/country-pack";
import { syncModuleManifest } from "../../entitlements/resolver";
import type { ConsumerContext } from "../../registry/types";
import type { ComposedEntry } from "../compose";
import type { PostingFailure, PostingProvider, PostingRule } from "../provider";
import { invoiceEvent, invoiceTemplate } from "./fixtures";

// The engine over a fake provider that records what it is asked (design §5.1, §5.5), and module.enable's pack check.

const rule = (id: string, priority: number, extra: Partial<PostingRule> = {}): PostingRule => ({ id, event: invoiceEvent.event, journalId: "j-ventas", template: invoiceTemplate, priority, ...extra });

function fakeProvider(options: { rules?: PostingRule[]; starts?: Date | null; unmapped?: string[]; postError?: Error } = {}) {
  const calls = { posted: [] as { entry: ComposedEntry; rule: PostingRule }[], failures: [] as PostingFailure[], skipped: [] as string[], reversed: [] as { event: string; sourceId: string }[] };
  const provider: PostingProvider = {
    rulesFor: async () => options.rules ?? [rule("r1", 1)],
    resolveAccount: async (_ctx, role, dimension) => (options.unmapped?.includes(role) ? null : { accountId: `id-${role}`, code: dimension && role === "revenue" ? `${role}:${dimension}` : role }),
    ledgerStartsOn: async () => (options.starts === undefined ? new Date("2026-01-01") : options.starts),
    composeSettings: async () => ({ tolerance: 1, companyCurrency: "COP" }),
    countSkipped: async (_ctx, eventId) => void calls.skipped.push(eventId),
    post: async (_ctx, entry, r) => {
      if (options.postError) throw options.postError;
      calls.posted.push({ entry, rule: r });
      return { entryId: `e${calls.posted.length}` };
    },
    reverse: async (_ctx, ref) => (calls.reversed.push(ref), { entryId: "rev" }),
    recordFailure: async (_ctx, failure) => void calls.failures.push(failure),
    effectsFor: async () => [],
  };
  return { provider, calls };
}
const ctx = (): ConsumerContext => ({ sql: undefined as never, companyId: "c1", chainId: "chain-1", runProcess: async () => ({}), event: { id: invoiceEvent.id, name: invoiceEvent.event, createdAt: invoiceEvent.createdAt } });
const deliver = (provider: PostingProvider) => postingConsumer(provider)(ctx(), invoiceEvent.payload);

describe("posting engine", () => {
  it("acknowledges events dated before ledgerStartsOn without posting and counts them", async () => {
    const { provider, calls } = fakeProvider({ starts: new Date("2027-01-01") });
    await deliver(provider);
    expect(calls.posted).toHaveLength(0);
    expect(calls.skipped).toEqual(["evt-1"]);
    const unset = fakeProvider({ starts: null });
    await deliver(unset.provider);
    expect(unset.calls.skipped).toEqual(["evt-1"]);
  });

  it("posts one entry per matching rule in priority order and records a failure for a rule with a missing mapping without stopping the others", async () => {
    const { provider, calls } = fakeProvider({ rules: [rule("late", 5), rule("first", 1), rule("broken", 3, { template: { ...invoiceTemplate, lines: [{ role: "suspense", side: "debit", amount: "$.totals.total" }, { role: "revenue", side: "credit", amount: "$.totals.total" }] } })], unmapped: ["suspense"] });
    await deliver(provider);
    expect(calls.posted.map((p) => p.rule.id)).toEqual(["first", "late"]);
    expect(calls.posted[0]!.entry.lines.map((l) => l.accountCode)).toEqual(["receivable", "revenue:category:bebidas", "revenue:category:comida", "vat_out"]);
    expect(calls.failures).toHaveLength(1);
    expect(calls.failures[0]).toMatchObject({ eventId: "evt-1", ruleId: "broken", code: "missing_account_mapping", event: invoiceEvent.event });
  });

  it("records an unbalanced composition as a failure", async () => {
    const t = { ...invoiceTemplate, lines: [{ role: "cash", side: "debit" as const, amount: "$.totals.total" }, { role: "revenue", side: "credit" as const, amount: "5" }] };
    const { provider, calls } = fakeProvider({ rules: [rule("r", 1, { template: t })] });
    await deliver(provider);
    expect(calls.failures[0]).toMatchObject({ code: "unbalanced", ruleId: "r" });
  });

  it("a reverseOf rule calls provider.reverse with the referenced event and source id", async () => {
    const { provider, calls } = fakeProvider({ rules: [rule("v", 1, { template: { description: "Anulación", lines: [], reverseOf: { event: "invoicing.invoice.issued", sourceId: "$.invoiceId" } } })] });
    await deliver(provider);
    expect(calls.reversed).toEqual([{ event: "invoicing.invoice.issued", sourceId: "inv-1" }]);
    expect(calls.posted).toHaveLength(0);
  });

  it("a connection error from provider.post propagates so the outbox retries; a ProcessError from provider.post is recorded as a failure", async () => {
    const down = fakeProvider({ postError: new Error("connection terminated") });
    await expect(deliver(down.provider)).rejects.toThrow(/connection terminated/);
    expect(down.calls.failures).toHaveLength(0);
    const refused = fakeProvider({ postError: new ProcessError("invalid_input", "Período cerrado", { details: ["closed_period"] }) });
    await deliver(refused.provider);
    expect(refused.calls.failures[0]).toMatchObject({ code: "closed_period", detail: "Período cerrado" });
  });
});

describe("module.enable and the country pack's role mappings", () => {
  const consult = (id: string) => defineProcess({ id, module: id.split(".")[0]!, kind: "consult", description: "prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) });
  const base = { version: "1", dependsOn: [], entities: [], features: [], events: { emits: [], consumes: {} }, navigation: [] };
  const ledger = defineModule({ ...base, id: "ledger", processes: [consult("ledger.thing.consult")], accountRoles: ["tips"] });
  const plain = defineModule({ ...base, id: "plain", processes: [consult("plain.thing.consult")] });
  const pack = (roles: string[]): CountryPack => ({ ...({} as CountryPack), code: "CO", accounting: { defaultRoleMappings: () => roles.map((role) => ({ role, code: "1" })) } as never });

  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let claims: JwtClaims;
  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule, ledger, plain]);
    for (const def of registry.modules()) await syncModuleManifest(sql, def);
    seed = await seedTenant(sql, { companies: 1, entitlements: ["module:ledger", "module:plain"] });
    claims = seed.claimsFor(seed.users.both, seed.companies[0]!.id);
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });
  const enable = async (moduleId: string) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${claims.sub}, ${claims.active_company_id}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { claims, origin: "ui", stepUpToken }, "kernel.admin.module.enable", { moduleId });
  };

  it("module.enable refuses a module whose accountRoles the pack does not map", async () => {
    registerCountryPack(pack(["cash"]));
    await expect(enable("ledger")).rejects.toMatchObject({ code: "invalid_input", details: ["El pack del país no mapea los roles contables: tips"] });
    registerCountryPack(pack(["cash", "tips"]));
    await expect(enable("ledger")).resolves.toMatchObject({ enabled: true });
    await expect(enable("plain")).resolves.toMatchObject({ enabled: true });
  });
});
