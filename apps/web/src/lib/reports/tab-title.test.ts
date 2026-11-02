import { describe, expect, it } from "vitest";
import { reportTabToRename } from "./tab-title";

const path = "/accounting/reports/trial_balance";

describe("reportTabToRename", () => {
  it("renames the generic 'Informes' tab of a report, with or without parameters", () => {
    expect(reportTabToRename([{ href: path, title: "Informes" }], path, "Balance de prueba", "Informes")).toEqual({ href: path, title: "Informes" });
    const withParams = { href: `${path}?p=%7B%7D`, title: "Informes" };
    expect(reportTabToRename([withParams], path, "Balance de prueba", "Informes")).toBe(withParams);
  });
  it("leaves a drill-down tab, an already named tab and other pages alone", () => {
    expect(reportTabToRename([{ href: `${path}?p=1`, title: "1105 · Caja · noviembre de 2026" }], path, "Balance de prueba", "Informes")).toBeUndefined();
    expect(reportTabToRename([{ href: path, title: "Balance de prueba" }], path, "Balance de prueba", "Informes")).toBeUndefined();
    expect(reportTabToRename([{ href: "/accounting/reports", title: "Informes" }], path, "Balance de prueba", "Informes")).toBeUndefined();
  });
});
