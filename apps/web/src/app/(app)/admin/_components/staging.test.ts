import { describe, expect, it } from "vitest";
import { issuesOf } from "@/lib/records/issues";
import { changesOf, moduleTarget, rebase, refusedCells, stage, stageAll } from "./staging";

// OD-7 (design §22.11): the admin matrices stage their cells locally and apply them with one batch process. The model
// keeps one entry per changed cell, drops a cell that is back to what is stored, and maps a refused batch back to its
// cells so the screen can mark them and keep everything staged.

describe("admin matrix staging", () => {
  it("stages a change and drops it when the cell is back to what is stored", () => {
    const one = stage({}, "r1:core.party.create", true, false);
    expect(one).toEqual({ "r1:core.party.create": true });
    expect(stage(one, "r1:core.party.create", false, false)).toEqual({});
    // Staging the stored value of an untouched cell is not a change.
    expect(stage({}, "r1:core.party.create", false, false)).toEqual({});
  });

  it("stages a whole module for one role in one step", () => {
    const pending = stageAll({ "r2:x.y.z": true }, [
      { key: "r1:a.b.create", value: true, stored: false },
      { key: "r1:a.b.update", value: true, stored: true },
      { key: "r1:a.b.consult", value: true, stored: false },
    ]);
    expect(pending).toEqual({ "r2:x.y.z": true, "r1:a.b.create": true, "r1:a.b.consult": true });
  });

  it("the module button gives everything unless everything is already given, then it takes everything away", () => {
    expect(moduleTarget([true, false, true])).toBe(true);
    expect(moduleTarget([false, false])).toBe(true);
    expect(moduleTarget([true, true])).toBe(false);
  });

  it("the changes keep the order the cells were staged in", () => {
    const pending = stage(stage({}, "b", "masked", "visible"), "a", "hidden", "visible");
    expect(changesOf(pending, (key, value) => ({ key, value }))).toEqual([
      { key: "b", value: "masked" },
      { key: "a", value: "hidden" },
    ]);
  });

  it("new server data keeps only the staged cells that still differ from it", () => {
    const stored: Record<string, boolean> = { a: true, b: false };
    expect(rebase({ a: true, b: true, c: true }, (key) => stored[key] ?? false)).toEqual({ b: true, c: true });
    // A cell the new data no longer has (its role is gone) is dropped.
    expect(rebase({ a: false, gone: true }, (key) => stored[key])).toEqual({ a: false });
  });

  it("a refused batch marks the cells it names, by index or by the Zod path of the change", () => {
    const keys = ["r1:a", "r1:b", "r1:c"];
    const details = issuesOf([{ index: 1, message: "Los procesos de administración son solo del rol admin" }]);
    expect(refusedCells(keys, details)).toEqual({ "r1:b": "Los procesos de administración son solo del rol admin" });
    // A repeated cell is refused by the input schema, on `changes.<index>`.
    const zod = issuesOf([{ code: "custom", path: ["changes", 2], message: "Ese permiso está repetido en la lista de cambios" }]);
    expect(refusedCells(keys, zod)).toEqual({ "r1:c": "Ese permiso está repetido en la lista de cambios" });
    // A refusal that names no change marks nothing (the reason still shows in the bar).
    expect(refusedCells(keys, issuesOf(["Sin permiso"]))).toEqual({});
  });
});
