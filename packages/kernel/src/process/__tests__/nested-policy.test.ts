import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Registry } from "../../registry";
import type { ModuleDef, ProcessDef } from "../../registry/types";
import { DEFAULT_NESTED_DEPTH, ledgerOrStockEvent, ledgerOrStockReason, NESTED_HARD_MAX, queuedReason } from "../nested-policy";
import { ProcessError } from "../errors";

// Plan 2B Task 32 (R32-5): «posts to the ledger or moves stock» is derived from the registry, never from a module name (rule 4). A process
// counts when its id is a key of any module's `effects`, or when an event it emits is a posting-rule event or an `effects` key of any module.

const process = (id: string, emits?: string[]): ProcessDef => ({
  id,
  module: id.slice(0, id.indexOf(".")),
  kind: "create",
  description: "prueba",
  input: z.object({}),
  output: z.object({}),
  handler: async () => ({}),
  ...(emits ? { emits } : {}),
});

const mod = (over: Partial<ModuleDef> & { id: string }): ModuleDef => ({
  version: "0.0.1",
  dependsOn: [],
  entities: [],
  processes: [],
  features: [],
  events: { emits: [], consumes: {} },
  navigation: [],
  ...over,
});

function fakeRegistry(): Registry {
  const registry = new Registry();
  const procs = [
    process("alpha.doc.post", ["alpha.doc.posted"]),
    process("alpha.doc.reserve", ["alpha.doc.reserved"]),
    process("alpha.doc.move"),
    process("alpha.doc.note", ["alpha.doc.noted"]),
    process("alpha.doc.plain"),
  ];
  for (const p of procs) registry.registerProcess(p);
  registry.registerModule(mod({ id: "alpha", processes: procs, events: { emits: ["alpha.doc.posted", "alpha.doc.reserved", "alpha.doc.noted"], consumes: {} } }));
  // Another module declares the posting rule and the effects (rule 3: by event name only).
  // Fix round 1 (I1): a module that posts (posting provider or rules) counts as a whole; a module that only declares effects counts for its
  // event-driven (consumer) processes.
  const betaPost = process("beta.entry.post");
  const gammaConsume = { ...process("gamma.doc.record"), origins: ["event" as const] };
  const gammaUi = process("gamma.doc.create");
  for (const p of [betaPost, gammaConsume, gammaUi]) registry.registerProcess(p);
  registry.registerModule(mod({ id: "gamma", processes: [gammaConsume, gammaUi], effects: { "alpha.doc.noted2": ["gamma.effects.x"] } }));
  registry.registerModule(
    mod({
      id: "beta",
      processes: [betaPost],
      postingRules: [{ event: "alpha.doc.posted", name: "regla", journalCode: "GJ", template: {} as never }],
      effects: { "alpha.doc.reserved": ["beta.effects.reserve"], "alpha.doc.move": ["beta.effects.move"] },
    }),
  );
  return registry;
}

describe("ledgerOrStockReason", () => {
  const registry = fakeRegistry();

  it("names a process whose emits hit a posting-rule event", () => {
    expect(ledgerOrStockReason(registry, "alpha.doc.post")).toMatch(/alpha\.doc\.posted/);
  });

  it("names a process whose emits hit an effects key", () => {
    expect(ledgerOrStockReason(registry, "alpha.doc.reserve")).toMatch(/alpha\.doc\.reserved/);
  });

  it("names a process whose own id is an effects key", () => {
    expect(ledgerOrStockReason(registry, "alpha.doc.move")).toMatch(/alpha\.doc\.move/);
  });

  it("answers null for a plain process, one whose event nobody posts or reacts to, and an unknown id", () => {
    expect(ledgerOrStockReason(registry, "alpha.doc.plain")).toBeNull();
    expect(ledgerOrStockReason(registry, "alpha.doc.note")).toBeNull();
    expect(ledgerOrStockReason(registry, "alpha.doc.nope")).toBeNull();
  });

  it("names any process of a module that posts, and an event-driven process of a module that declares effects", () => {
    expect(ledgerOrStockReason(registry, "beta.entry.post")).toMatch(/beta/);
    expect(ledgerOrStockReason(registry, "gamma.doc.record")).toMatch(/gamma/);
    expect(ledgerOrStockReason(registry, "gamma.doc.create")).toBeNull();
  });

  it("ledgerOrStockEvent checks one emitted event against the same set", () => {
    expect(ledgerOrStockEvent(registry, "alpha.doc.posted")).toBe(true);
    expect(ledgerOrStockEvent(registry, "alpha.doc.reserved")).toBe(true);
    expect(ledgerOrStockEvent(registry, "alpha.doc.noted")).toBe(false);
  });
});

describe("nested-run constants and the queued reason", () => {
  it("has the hard maximum 8 and the default depth 4", () => {
    expect(NESTED_HARD_MAX).toBe(8);
    expect(DEFAULT_NESTED_DEPTH).toBe(4);
  });

  it("keeps a typed Spanish refusal and replaces anything else by a fixed text (never a raw SQL or stack message)", () => {
    expect(queuedReason(new ProcessError("invalid_input", "x", { details: ["El ticket está cerrado"] }))).toBe("El ticket está cerrado");
    expect(queuedReason(new ProcessError("invalid_input", "x", { details: [{ message: "Requerido", path: ["name"] }] }))).toBe("Requerido");
    const failed = queuedReason(new ProcessError("handler_failed", "process x failed: duplicate key value violates unique constraint"));
    expect(failed).not.toMatch(/duplicate|constraint/);
    expect(failed.length).toBeGreaterThan(0);
    expect(queuedReason(new ProcessError("invalid_input", "x", { details: ["a".repeat(900)] })).length).toBeLessThanOrEqual(500);
  });
});
