import { describe, expect, it } from "vitest";
import { chartWidgetId, DEFAULT_HOME_LAYOUT, defaultModuleLayout, isModuleWidgetId, moduleLayoutKey, sanitizeHiddenItems, HOME_MIN_HEIGHT, moveWidget, resizedHeight, resizedSpan, resolveHomeLayout, sanitizeHomeLayout } from "../home-model";

// The home dashboard's layout rules (design §19a, rule 25): a layout is a list of `{ id, w, h }` (w 1–4 columns, h at
// least 160 px); anything else saved falls back to the default.

const ids = (layout: { id: string }[]) => layout.map((w) => w.id);

describe("sanitizeHomeLayout", () => {
  it("accepts a layout of known widgets and rounds the height", () => {
    expect(sanitizeHomeLayout([{ id: "recent", w: 2, h: 300.4 }, { id: "kpis", w: 4, h: 200 }])).toEqual([
      { id: "recent", w: 2, h: 300 },
      { id: "kpis", w: 4, h: 200 },
    ]);
  });

  it("clamps the span to 1–4 and the height to the minimum", () => {
    expect(sanitizeHomeLayout([{ id: "kpis", w: 9, h: 10 }, { id: "help", w: 0, h: 99_999 }])).toEqual([
      { id: "kpis", w: 4, h: HOME_MIN_HEIGHT },
      { id: "help", w: 1, h: 1200 },
    ]);
  });

  it("refuses an unknown widget, a repeated one, a non-array and malformed entries", () => {
    expect(sanitizeHomeLayout([{ id: "ghost", w: 1, h: 200 }])).toBeNull();
    expect(sanitizeHomeLayout([{ id: "kpis", w: 1, h: 200 }, { id: "kpis", w: 1, h: 200 }])).toBeNull();
    expect(sanitizeHomeLayout({ id: "kpis" })).toBeNull();
    expect(sanitizeHomeLayout([{ id: "kpis", w: "2", h: 200 }])).toBeNull();
    expect(sanitizeHomeLayout([null])).toBeNull();
    expect(sanitizeHomeLayout([])).toBeNull();
  });
});

describe("resolveHomeLayout", () => {
  it("falls back to the default layout for an unknown widget id", () => {
    expect(resolveHomeLayout([{ id: "kpis", w: 1, h: 200 }, { id: "ghost", w: 1, h: 200 }])).toEqual(DEFAULT_HOME_LAYOUT);
    expect(resolveHomeLayout(null)).toEqual(DEFAULT_HOME_LAYOUT);
  });

  it("appends a widget the saved layout does not know yet, after the user's own", () => {
    const resolved = resolveHomeLayout([{ id: "help", w: 1, h: 200 }, { id: "kpis", w: 4, h: 200 }]);
    expect(ids(resolved).slice(0, 2)).toEqual(["help", "kpis"]);
    expect(ids(resolved).sort()).toEqual(ids([...DEFAULT_HOME_LAYOUT]).sort());
  });
});

describe("moveWidget", () => {
  const layout = [{ id: "a", w: 1, h: 200 }, { id: "b", w: 1, h: 200 }, { id: "c", w: 1, h: 200 }, { id: "d", w: 1, h: 200 }, { id: "e", w: 1, h: 200 }];

  it("moves a widget to the place of another, like the prototype's splice", () => {
    expect(ids(moveWidget(layout, "e", "a"))).toEqual(["e", "a", "b", "c", "d"]);
    expect(ids(moveWidget(layout, "a", "c"))).toEqual(["b", "c", "a", "d", "e"]);
  });

  it("returns the same layout for a move onto itself or an unknown id", () => {
    expect(moveWidget(layout, "b", "b")).toBe(layout);
    expect(moveWidget(layout, "b", "zz")).toBe(layout);
  });
});

describe("resizing", () => {
  it("snaps the span to whole columns", () => {
    const column = 294;
    const gap = 12;
    expect(resizedSpan(1, 0, column, gap)).toBe(1);
    expect(resizedSpan(1, column + gap, column, gap)).toBe(2);
    expect(resizedSpan(2, 2000, column, gap)).toBe(4);
    expect(resizedSpan(3, -2000, column, gap)).toBe(1);
  });

  it("keeps the height free above the minimum", () => {
    expect(resizedHeight(300, 55)).toBe(355);
    expect(resizedHeight(300, -500)).toBe(HOME_MIN_HEIGHT);
  });
});

describe("a module's Inicio layout", () => {
  it("its widgets are the indicators strip and one card per chart, two to a row", () => {
    expect(defaultModuleLayout(["accounting.top_expenses", "accounting.result_trend"])).toEqual([
      { id: "kpis", w: 4, h: 170 },
      { id: "chart:accounting.top_expenses", w: 2, h: 300 },
      { id: "chart:accounting.result_trend", w: 2, h: 300 },
    ]);
    expect(chartWidgetId("core.parties_growth")).toBe("chart:core.parties_growth");
    expect(moduleLayoutKey("accounting")).toBe("home_layout.accounting");
  });

  it("knows a module page's widgets by their shape, not the company-wide ones", () => {
    expect(isModuleWidgetId("kpis")).toBe(true);
    expect(isModuleWidgetId("chart:kernel.audit_daily")).toBe(true);
    for (const id of ["recent", "help", "chart:nope", "chart:", "kpis2", "chart:A.b"]) expect(isModuleWidgetId(id)).toBe(false);
  });

  it("a saved layout with a chart the page no longer has is still valid; one with a foreign widget is not", () => {
    const saved = [{ id: "chart:accounting.gone", w: 2, h: 300 }, { id: "kpis", w: 4, h: 170 }];
    expect(sanitizeHomeLayout(saved, isModuleWidgetId)).toEqual(saved);
    expect(sanitizeHomeLayout([{ id: "recent", w: 2, h: 300 }], isModuleWidgetId)).toBeNull();
    const defaults = defaultModuleLayout(["accounting.new"]);
    expect(resolveHomeLayout(saved, defaults, isModuleWidgetId).map((w) => w.id)).toEqual(["chart:accounting.gone", "kpis", "chart:accounting.new"]);
  });
});

describe("sanitizeHiddenItems", () => {
  it("keeps a list of KPI and chart ids once each, sorted", () => {
    expect(sanitizeHiddenItems(["core.parties", "accounting.top_expenses", "core.parties"])).toEqual(["accounting.top_expenses", "core.parties"]);
    expect(sanitizeHiddenItems([])).toEqual([]);
  });

  it("refuses anything that is not such a list", () => {
    for (const bad of [null, "core.parties", [1], ["Core.Parties"], ["kpis"], ["a b.c"], Array.from({ length: 201 }, (_, i) => `core.k${i}`)]) expect(sanitizeHiddenItems(bad)).toBeNull();
  });
});
