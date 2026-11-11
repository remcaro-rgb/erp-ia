import { describe, expect, it } from "vitest";
import { defineModule, loadModules, Registry, type RecordTabContribution } from "@erp/kernel";
import { resolveContributedTabs, type ContributionProbe } from "../contributed";

// The tabs a module's manifest adds to other entities' record pages (design §5.16 and accounting design §8): a grid
// tab shows only when its source view has rows for the record, a mapping tab when the caller may use its processes.

const RECORD = "0197a1b2-0000-7000-8000-0000000000aa";
const grid: RecordTabContribution = { id: "m.entries", label: "tab.entries", forEntities: "*", kind: "grid", feature: "m.f", source: "m.entry_source" };
const mapping: RecordTabContribution = {
  id: "m.revenue",
  label: "tab.revenue",
  forEntities: ["core.product_category"],
  kind: "mapping",
  feature: "m.f",
  dimension: "category:{id}",
  roles: ["revenue"],
  lookupEntity: "m.account",
  saveProcess: "m.mapping.update",
  consultProcess: "m.mapping.consult",
};

const registry = new Registry();
loadModules(registry, [
  defineModule({
    id: "m",
    version: "1",
    dependsOn: [],
    entities: [],
    processes: [],
    features: [{ id: "m.f", label: "feature.m", processes: [], entities: [] }],
    events: { emits: [], consumes: {} },
    navigation: [],
    recordTabs: [grid, mapping],
  }),
]);

/** A probe with a fake view: `rows` counts per source, the features the company holds and the processes the caller may run. */
const probe = (over: Partial<{ rows: Record<string, number | null>; features: string[]; runnable: string[] }> = {}) => {
  const asked: Array<{ source: string; filters: unknown }> = [];
  const p: ContributionProbe = {
    entitled: async (feature) => (over.features ?? ["m.f"]).includes(feature),
    rowCount: async (source, filters) => {
      asked.push({ source, filters });
      return over.rows && source in over.rows ? over.rows[source]! : 0;
    },
    runnable: new Set(over.runnable ?? ["m.mapping.update", "m.mapping.consult"]),
  };
  return { p, asked };
};

describe("contributed tabs", () => {
  it("the record page lists a grid contribution only when the source view has rows for the record", async () => {
    const none = probe({ rows: { "m.entry_source": 0 } });
    expect(await resolveContributedTabs(registry, "core.party", RECORD, none.p)).toEqual([]);

    const one = probe({ rows: { "m.entry_source": 1 } });
    const tabs = await resolveContributedTabs(registry, "core.party", RECORD, one.p);
    expect(tabs).toEqual([
      {
        id: "m.entries",
        label: "tab.entries",
        kind: "grid",
        count: 1,
        source: "m.entry_source",
        filters: [
          { field: "source_entity", op: "eq", value: "core.party" },
          { field: "source_record_id", op: "eq", value: RECORD },
        ],
      },
    ]);
    // The view is asked with exactly those two filters.
    expect(one.asked).toEqual([{ source: "m.entry_source", filters: tabs[0]!.filters }]);
  });

  it("a view the caller may not read, or a feature the company does not hold, shows no tab", async () => {
    expect(await resolveContributedTabs(registry, "core.party", RECORD, probe({ rows: { "m.entry_source": null } }).p)).toEqual([]);
    expect(await resolveContributedTabs(registry, "core.party", RECORD, probe({ rows: { "m.entry_source": 3 }, features: [] }).p)).toEqual([]);
  });

  it("a mapping contribution shows for its entity to a caller who may use its processes, with the record's dimension", async () => {
    const tabs = await resolveContributedTabs(registry, "core.product_category", RECORD, probe().p);
    expect(tabs.map((t) => t.id)).toEqual(["m.revenue"]);
    expect(tabs[0]).toMatchObject({
      kind: "mapping",
      label: "tab.revenue",
      mapping: { dimension: `category:${RECORD}`, roles: ["revenue"], lookupEntity: "m.account", saveProcess: "m.mapping.update", consultProcess: "m.mapping.consult" },
    });
    // Neither process runnable: no tab. Only the consult: the tab shows read-only.
    expect(await resolveContributedTabs(registry, "core.product_category", RECORD, probe({ runnable: [] }).p)).toEqual([]);
    const readOnly = await resolveContributedTabs(registry, "core.product_category", RECORD, probe({ runnable: ["m.mapping.consult"] }).p);
    expect(readOnly[0]).toMatchObject({ id: "m.revenue", mapping: { canSave: false } });
    expect(tabs[0]).toMatchObject({ mapping: { canSave: true } });
  });

  // Plan 2B.2 Task 29.4 (RG-9): the pedido's «Alistamientos» tab, keyed by the source's order_id, with «Crear alistamiento».
  it("a grid keyed by its record field filters by it, and its action shows the tab without rows to a caller who may run it", async () => {
    const picks: RecordTabContribution = { id: "w.picks", label: "tab.picks", forEntities: ["sales.order"], kind: "grid", feature: "w.f", source: "w.pick", recordField: "order_id", action: { label: "tab.create_pick", process: "w.pick.create", inputField: "orderId" } };
    const own = new Registry();
    loadModules(own, [
      defineModule({
        id: "w", version: "1", dependsOn: [], entities: [],
        processes: [{ id: "w.pick.create", module: "w", kind: "create", description: "x", input: {} as never, output: {} as never, handler: async () => null } as never],
        features: [{ id: "w.f", label: "feature.w", processes: ["w.pick.create"], entities: [] }],
        events: { emits: [], consumes: {} }, navigation: [], recordTabs: [picks],
      }),
    ]);
    const filters = [{ field: "order_id", op: "eq", value: RECORD }];
    const empty = probe({ features: ["w.f"], rows: { "w.pick": 0 }, runnable: ["w.pick.create"] });
    expect(await resolveContributedTabs(own, "sales.order", RECORD, empty.p)).toEqual([
      { id: "w.picks", label: "tab.picks", kind: "grid", count: 0, source: "w.pick", filters, action: { label: "tab.create_pick", process: "w.pick.create", inputField: "orderId" } },
    ]);
    expect(empty.asked).toEqual([{ source: "w.pick", filters }]);
    // Without the right to run it, the tab needs rows as any grid, and offers no button.
    expect(await resolveContributedTabs(own, "sales.order", RECORD, probe({ features: ["w.f"], rows: { "w.pick": 0 }, runnable: [] }).p)).toEqual([]);
    expect(await resolveContributedTabs(own, "sales.order", RECORD, probe({ features: ["w.f"], rows: { "w.pick": 2 }, runnable: [] }).p)).toEqual([
      { id: "w.picks", label: "tab.picks", kind: "grid", count: 2, source: "w.pick", filters },
    ]);
    // A source the caller may not read shows no tab, button or not.
    expect(await resolveContributedTabs(own, "sales.order", RECORD, probe({ features: ["w.f"], rows: { "w.pick": null }, runnable: ["w.pick.create"] }).p)).toEqual([]);
  });
});
