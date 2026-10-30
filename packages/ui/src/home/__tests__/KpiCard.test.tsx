// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { KpiCard } from "../KpiCard";

afterEach(cleanup);

describe("KpiCard", () => {
  it("shows the label, the count and the detail line with its numbers", () => {
    renderEs(
      <KpiCard
        kpi={{ id: "core.parties", label: "home.kpi.core_parties.label", value: 38, unit: "count", progress: 0.95, detail: { key: "home.kpi.core_parties.detail", params: { total: 40, not_ready: 3 } } }}
      />,
    );
    expect(screen.getByText("Terceros activos")).toBeTruthy();
    expect(screen.getByText("38")).toBeTruthy();
    expect(screen.getByText(/40 en total/)).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("95");
  });

  it("shows a percentage with a space before the sign, and a warn tone", () => {
    renderEs(<KpiCard kpi={{ id: "kernel.ai_tokens", label: "home.kpi.kernel_ai_tokens.label", value: 38, unit: "percent", progress: 0.38, tone: "warn" }} />);
    expect(screen.getByText("38 %")).toBeTruthy();
    expect(screen.getByTestId("kpi-value").getAttribute("data-tone")).toBe("warn");
  });

  it("formats tokens compactly in the user's language", () => {
    renderEs(<KpiCard kpi={{ id: "kernel.ai_tokens", label: "home.kpi.kernel_ai_tokens.label", value: 1_900_000, unit: "tokens" }} />);
    expect(screen.getByTestId("kpi-value").textContent).toMatch(/1,9\s?M/);
  });

  it("shows money as $ 1.234.567,00 (rule 23), negative results included", () => {
    renderEs(<KpiCard kpi={{ id: "accounting.result_month", label: "home.kpi.accounting_result.label", value: 3_750_000, unit: "money", detail: { key: "home.kpi.accounting_result.detail", params: { month: "2026-10" } } }} />);
    expect(screen.getByText("Resultado del mes")).toBeTruthy();
    expect(screen.getByTestId("kpi-value").textContent?.replace(/\s/g, " ")).toBe("$ 3.750.000,00");
    expect(screen.getByText("Estado de resultados de 2026-10")).toBeTruthy();
    cleanup();
    renderEs(<KpiCard kpi={{ id: "accounting.result_month", label: "home.kpi.accounting_result.label", value: -1_250_000.5, unit: "money" }} />);
    expect(screen.getByTestId("kpi-value").textContent).toMatch(/-\s?\$\s?1\.250\.000,50|\$\s?-1\.250\.000,50/);
  });

  const series = [3, 5, 4, 6, 8, 7, 9, 6, 10, 12, 11, 9, 13, 14];

  it("shows the 14-day trend under the value with an accessible name from the first to the last day", () => {
    renderEs(<KpiCard kpi={{ id: "core.parties", label: "home.kpi.core_parties.label", value: 482, unit: "count", series }} />);
    const trend = screen.getByRole("img", { name: "Tendencia 14 días: de 3 a 14" });
    expect(trend.closest("[data-kpi]")!.getAttribute("data-kpi")).toBe("core.parties");
  });

  it("reads the trend of a token card in compact form", () => {
    const tokens = Array.from({ length: 14 }, (_, i) => (i === 0 ? 1200 : i === 13 ? 3_400_000 : 2000));
    renderEs(<KpiCard kpi={{ id: "kernel.ai_tokens", label: "home.kpi.kernel_ai_tokens.label", value: 76, unit: "percent", series: tokens }} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toMatch(/^Tendencia 14 días: de 1,2\s?(K|mil) a 3,4\s?M$/);
  });

  it("has no trend line without a series or with fewer than two points", () => {
    renderEs(<KpiCard kpi={{ id: "a.b", label: "home.kpi.core_parties.label", value: 1, unit: "count" }} />);
    expect(screen.queryByRole("img")).toBeNull();
    cleanup();
    renderEs(<KpiCard kpi={{ id: "a.b", label: "home.kpi.core_parties.label", value: 1, unit: "count", series: [1] }} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps the card's height whether or not it has a trend: the 28 px slot is reserved by a class, not by the line", () => {
    const { container } = renderEs(<KpiCard kpi={{ id: "a.b", label: "home.kpi.core_parties.label", value: 1, unit: "count" }} />);
    const slot = container.querySelector(".erp-home-kpi__trend-slot");
    expect(slot).not.toBeNull();
    cleanup();
    const withSeries = renderEs(<KpiCard kpi={{ id: "a.b", label: "home.kpi.core_parties.label", value: 1, unit: "count", series }} />);
    const slot2 = withSeries.container.querySelector(".erp-home-kpi__trend-slot");
    expect(slot2).not.toBeNull();
    expect(slot2!.className).toBe(slot!.className);
    expect(slot2!.querySelector("svg.erp-home-kpi__trend")).not.toBeNull();
  });
});
