// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { FilterRow } from "../FilterRow";
import type { GridColumn } from "../types";

afterEach(cleanup);

const column = (field: string, kind: string, label: string) => ({ field, label, kind, type: kind, mode: "visible", filterable: true, sortable: true }) as unknown as GridColumn;

function draw() {
  renderEs(
    <table>
      <thead>
        <FilterRow columns={[column("total", "number", "Total"), column("date", "date", "Fecha")]} values={{}} onChange={vi.fn()} />
      </thead>
    </table>,
  );
}

describe("FilterRow", () => {
  it("shows the number placeholder as an example and explains the operators", () => {
    draw();
    const box = screen.getByRole("textbox", { name: "Filtrar Total" });
    expect(box.getAttribute("placeholder")).toBe("Ej. >= 1000");
    expect(box.getAttribute("title")).toContain("1000..5000");
  });

  it("groups a date range under the column's name and names each end", () => {
    draw();
    expect(screen.getByRole("group", { name: "Filtrar Fecha" })).toBeTruthy();
    expect(screen.getByLabelText("Filtrar Fecha · Desde")).toBeTruthy();
    expect(screen.getByLabelText("Filtrar Fecha · Hasta")).toBeTruthy();
  });
});
