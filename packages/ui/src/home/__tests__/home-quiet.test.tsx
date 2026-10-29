// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { Dashboard, type DashboardWidget } from "../Dashboard";
import { UpdatedAt } from "../UpdatedAt";
import { RecentWidget } from "../widgets";
import { CellFormatProvider } from "../../grid/cell-format";
import { memoryStorage, renderEs } from "../../shell/__tests__/intl";

// UI density audit quick win 15 (M11): the home is quieter. The size hint shows only while a card is resized or has the
// caret, the recent-records list is a styled 36 px table, and snapshot widgets say when their data was read.

afterEach(cleanup);
const css = readFileSync(join(import.meta.dirname, "..", "..", "styles", "components.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

describe("home without noise", () => {
  it("draws a widget's meta in its header and marks the size hint so it shows only while resizing or focused", () => {
    const widgets: DashboardWidget[] = [{ id: "w1", title: "Indicadores", content: <p>cuerpo</p>, meta: <span>Actualizado 10:42</span> }];
    renderEs(<Dashboard userId="u1" companyId="c1" widgets={widgets} defaultLayout={[{ id: "w1", w: 4, h: 200 }]} initial={null} storage={memoryStorage()} onChange={vi.fn()} />);
    const region = screen.getByRole("region", { name: "Indicadores" });
    const header = region.querySelector(".erp-wg__hd")!;
    expect(within(header as HTMLElement).getByText("Actualizado 10:42")).toBeTruthy();
    const size = header.querySelector(".erp-wg__size")!;
    expect(size.textContent).toContain("4/4");
    expect(size.getAttribute("aria-hidden")).toBe("true");
    expect(css).toMatch(/\.erp-wg__size\s*\{[^}]*opacity:\s*0/);
    expect(css).toMatch(/\.erp-wg\[data-resizing="true"\] \.erp-wg__size[^{]*\.erp-wg:focus-within \.erp-wg__size[^{]*\{[^}]*opacity:\s*1/);
  });

  it("says when the data was read, as hh:mm in the company's zone", () => {
    renderEs(
      <CellFormatProvider timeZone="America/Bogota">
        <UpdatedAt at="2026-10-28T15:04:00.000Z" />
      </CellFormatProvider>,
    );
    const time = screen.getByText("Actualizado 10:04");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-10-28T15:04:00.000Z");
  });

  it("styles the recent records as a table with a header band and 36 px rows, times right-aligned", () => {
    renderEs(<RecentWidget records={[{ entity: "core.party", entityLabel: "entity.core.party", id: "p1", title: "Supermercados Éxito", action: "update", at: "2026-10-28T15:30:00Z", href: "/r/core.party/p1" }]} onOpen={vi.fn()} />);
    expect(screen.getByRole("columnheader", { name: "Cuándo" }).className).toContain("erp-num");
    expect(screen.getByRole("row", { name: /Supermercados/ }).querySelector("time")!.getAttribute("datetime")).toBe("2026-10-28T15:30:00Z");
    expect(css).toMatch(/\.erp-home-list th\s*\{[^}]*background:\s*var\(--head\)/);
    expect(css).toMatch(/\.erp-home-list td\s*\{[^}]*height:\s*36px/);
    expect(css).toMatch(/\.erp-home-list :is\(th, td\)\.erp-num\s*\{[^}]*text-align:\s*right/);
  });
});
