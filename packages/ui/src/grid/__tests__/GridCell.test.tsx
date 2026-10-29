// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { GridCell } from "../GridCell";
import { CellFormatProvider } from "../cell-format";
import { ResultTable } from "../../assistant/ResultTable";
import { renderEs } from "../../shell/__tests__/intl";
import type { GridColumn } from "../types";

// The grid's cells and the assistant's result tables format a value with the same code, in the company's zone.

afterEach(cleanup);

const column = (over: Partial<GridColumn>): GridColumn => ({ field: "f", label: "F", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true, ...over });
const inRow = (cell: React.ReactNode) => (
  <table>
    <tbody>
      <tr>{cell}</tr>
    </tbody>
  </table>
);

describe("GridCell", () => {
  it("shows a date and time in the company's zone given by the shell, and a date alone as the same day", () => {
    renderEs(
      <CellFormatProvider timeZone="Asia/Tokyo">
        {inRow(<GridCell column={column({ field: "at", type: "datetime" })} row={{ id: "1", at: "2026-10-28T03:30:00Z" }} />)}
        {inRow(<GridCell column={column({ field: "due", type: "date" })} row={{ id: "1", due: "2026-10-27" }} />)}
      </CellFormatProvider>,
    );
    expect(screen.getByText(/^28\/10\/26.*12:30/)).toBeTruthy();
    expect(screen.getByText("27/10/26")).toBeTruthy();
  });

  it("a grid cell and a result table cell show the same text for the same value", () => {
    const value = { id: "1", at: "2026-10-28T03:30:00Z", total: "1234567.0000" };
    renderEs(
      <CellFormatProvider timeZone="Asia/Tokyo">
        {inRow(<GridCell column={column({ field: "at", type: "datetime" })} row={value} />)}
        <ResultTable entity="e" rows={[value]} columns={[{ field: "at", type: "datetime", label: "A" }]} state={{ filters: [], sort: [], page: 1, pageSize: 50 }} />
      </CellFormatProvider>,
    );
    expect(screen.getAllByText(/^28\/10\/26.*12:30/)).toHaveLength(2);
  });

  it("shows what the grid's renderer gives for a column, the default text when it gives nothing, and never unmasks", () => {
    const render = (c: GridColumn, row: { id: string } & Record<string, unknown>) =>
      c.field === "process_id" ? (
        <span>
          Crea un tercero <span className="erp-mono">{String(row.process_id)}</span>
        </span>
      ) : undefined;
    renderEs(
      <>
        {inRow(<GridCell column={column({ field: "process_id" })} row={{ id: "1", process_id: "core.party.create" }} render={render} />)}
        {inRow(<GridCell column={column({ field: "entity" })} row={{ id: "1", entity: "core.parties" }} render={render} />)}
        {inRow(<GridCell column={column({ field: "process_id", mode: "masked" })} row={{ id: "2", process_id: "kernel.secret" }} render={render} />)}
      </>,
    );
    expect(screen.getByText("core.party.create").closest("td")!.textContent).toBe("Crea un tercero core.party.create");
    expect(screen.getByText("core.parties")).toBeTruthy();
    expect(screen.queryByText("kernel.secret")).toBeNull();
    expect(screen.getByText("••••••")).toBeTruthy();
  });
});
