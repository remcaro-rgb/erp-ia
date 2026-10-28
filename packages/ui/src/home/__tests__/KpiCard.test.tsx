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
});
