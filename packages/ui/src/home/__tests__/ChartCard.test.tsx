// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import type { Chart } from "@erp/kernel";
import { ChartCard } from "../ChartCard";
import { renderEs } from "../../shell/__tests__/intl";

afterEach(cleanup);

const base = { id: "accounting.income_vs_expenses", label: "home.chart.accounting_income_vs_expenses.label" } as const;

describe("ChartCard", () => {
  it("draws grouped bars with a legend, one column per category, and reads every value out in the image's name", () => {
    const chart: Chart = {
      ...base,
      kind: "bar",
      unit: "money",
      series: [
        { label: "home.chart.series.income", points: [{ label: "2026-09", value: 1000 }, { label: "2026-10", value: 2500 }] },
        { label: "home.chart.series.expenses", points: [{ label: "2026-09", value: 400 }, { label: "2026-10", value: 900 }] },
      ],
    };
    renderEs(<ChartCard chart={chart} />);
    const image = screen.getByRole("img");
    expect(image.getAttribute("data-kind")).toBe("bar");
    expect(image.getAttribute("aria-label")).toContain("Ingresos: 2026-09 $ 1.000,00; 2026-10 $ 2.500,00");
    expect(image.getAttribute("aria-label")).toContain("Gastos: 2026-09 $ 400,00; 2026-10 $ 900,00");
    expect(image.querySelectorAll(".erp-chart__col")).toHaveLength(2);
    expect(image.querySelectorAll(".erp-chart__bar")).toHaveLength(4);
    expect(image.querySelector(".erp-chart__legend")?.textContent).toBe("IngresosGastos");
  });

  it("translates the point labels of a chart that names them by key and sizes the bars against the largest", () => {
    const chart: Chart = {
      id: "accounting.entries_by_status",
      label: "home.chart.accounting_entries_by_status.label",
      kind: "bar",
      unit: "count",
      i18n: true,
      series: [{ label: "home.chart.series.entries", points: [{ label: "home.chart.point.entry_draft", value: 2 }, { label: "home.chart.point.entry_saved", value: 8 }] }],
    };
    renderEs(<ChartCard chart={chart} />);
    const labels = [...document.querySelectorAll(".erp-chart__collabel")].map((n) => n.textContent);
    expect(labels).toEqual(["Borrador", "Grabado"]);
    const heights = [...document.querySelectorAll<HTMLElement>(".erp-chart__bar i")].map((n) => n.style.height);
    expect(heights).toEqual(["25%", "100%"]);
  });

  it("lays long labels out as horizontal rows (top expenses by account)", () => {
    const chart: Chart = {
      id: "accounting.top_expenses",
      label: "home.chart.accounting_top_expenses.label",
      kind: "bar",
      unit: "money",
      series: [{ label: "home.chart.series.expenses", points: [{ label: "5105 Gastos de personal", value: 3000000 }, { label: "5135 Servicios", value: 1500000 }] }],
    };
    renderEs(<ChartCard chart={chart} />);
    expect(document.querySelectorAll(".erp-chart__rows li")).toHaveLength(2);
    expect(document.querySelector(".erp-chart__rowlabel")?.textContent).toBe("5105 Gastos de personal");
    expect(document.querySelector<HTMLElement>(".erp-chart__track i")?.style.width).toBe("100%");
  });

  it("draws a trend line with its first and last labels and the latest value", () => {
    const chart: Chart = {
      id: "kernel.ai_tokens_daily",
      label: "home.chart.kernel_ai_tokens_daily.label",
      kind: "line",
      unit: "tokens",
      series: [{ label: "home.chart.series.tokens", points: [{ label: "11-01", value: 0 }, { label: "11-02", value: 1500 }, { label: "11-03", value: 4200 }] }],
    };
    renderEs(<ChartCard chart={chart} />);
    expect(screen.getByRole("img").getAttribute("data-kind")).toBe("line");
    expect(document.querySelectorAll(".erp-chart__line svg path")).toHaveLength(3);
    expect(screen.getByTestId("chart-last").textContent).toMatch(/^4,2\s*K$/);
    expect(document.querySelector(".erp-chart__line")?.textContent).toContain("11-01");
    expect(document.querySelector(".erp-chart__line")?.textContent).toContain("11-03");
  });

  it("says so when there is nothing to draw", () => {
    renderEs(<ChartCard chart={{ ...base, kind: "bar", unit: "count", series: [{ label: "home.chart.series.entries", points: [] }] }} />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("Todavía no hay datos para este gráfico.")).toBeTruthy();
  });
});
