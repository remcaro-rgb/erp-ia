// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { GridCell } from "../GridCell";
import { NavigateProvider } from "../../shell/navigate";
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
  it("a reference the viewer cannot read (no label) that the column marks unavailable is plain text: no id, no link", () => {
    const ref = { entity: "sales.order", display: "number" };
    const id = "01a1b6fb-7438-72b1-a9dc-af0df7f1f287";
    renderEs(
      <NavigateProvider navigate={vi.fn()}>
        {inRow(<GridCell column={column({ field: "order_id", type: "ref", ref, linkable: true, unavailable: "Pedido no disponible" })} row={{ id: "1", order_id: id }} />)}
        {inRow(<GridCell column={column({ field: "order_id", type: "ref", ref, linkable: true, unavailable: "Pedido no disponible" })} row={{ id: "2", order_id: id, order_id_label: "PED-7" }} />)}
      </NavigateProvider>,
    );
    expect(screen.getByText("Pedido no disponible")).toBeTruthy();
    expect(screen.queryByText(id.slice(0, 8), { exact: false })).toBeNull();
    // A readable one still names and links.
    expect(screen.getByText("PED-7")).toBeTruthy();
    expect(document.querySelectorAll(`a[href*="${id}"]`)).toHaveLength(1);
  });

  it("a readable pedido whose number the viewer does not see (marked found, no label) shows «—», not «Pedido no disponible» (Task 39 m2)", () => {
    const ref = { entity: "sales.order", display: "number" };
    const id = "01a1b6fb-7438-72b1-a9dc-af0df7f1f287";
    renderEs(
      <NavigateProvider navigate={vi.fn()}>
        {inRow(<GridCell column={column({ field: "order_id", type: "ref", ref, linkable: true, unavailable: "Pedido no disponible" })} row={{ id: "1", order_id: id, order_id_found: true }} />)}
      </NavigateProvider>,
    );
    expect(screen.queryByText("Pedido no disponible")).toBeNull();
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(id.slice(0, 8), { exact: false })).toBeNull();
    expect(document.querySelectorAll(`a[href*="${id}"]`)).toHaveLength(0);
  });

  it("D20: a placeholder row shows «••••» in every cell it masks and its own values (the line number) as they are", () => {
    const row = { id: "1", __row_masked: true, line_no: 3, debit: null, account_id: null };
    renderEs(
      <NavigateProvider navigate={vi.fn()}>
        {inRow(<GridCell column={column({ field: "line_no", type: "number" })} row={row} />)}
        {inRow(<GridCell column={column({ field: "debit", type: "money" })} row={row} />)}
        {inRow(<GridCell column={column({ field: "account_id", type: "ref", ref: { entity: "accounting.account", labelField: "name" } as never })} row={row} />)}
      </NavigateProvider>,
    );
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getAllByText("••••")).toHaveLength(2);
  });

  it("shows a date and time in the company's zone given by the shell, and a date alone as the same day", () => {
    renderEs(
      <CellFormatProvider timeZone="Asia/Tokyo">
        {inRow(<GridCell column={column({ field: "at", type: "datetime" })} row={{ id: "1", at: "2026-10-28T03:30:00Z" }} />)}
        {inRow(<GridCell column={column({ field: "due", type: "date" })} row={{ id: "1", due: "2026-10-27" }} />)}
      </CellFormatProvider>,
    );
    expect(screen.getByText(/^2026\/10\/28 12:30/)).toBeTruthy();
    expect(screen.getByText("2026/10/27")).toBeTruthy();
  });

  it("a grid cell and a result table cell show the same text for the same value", () => {
    const value = { id: "1", at: "2026-10-28T03:30:00Z", total: "1234567.0000" };
    renderEs(
      <CellFormatProvider timeZone="Asia/Tokyo">
        {inRow(<GridCell column={column({ field: "at", type: "datetime" })} row={value} />)}
        <ResultTable entity="e" rows={[value]} columns={[{ field: "at", type: "datetime", label: "A" }]} state={{ filters: [], sort: [], page: 1, pageSize: 50 }} />
      </CellFormatProvider>,
    );
    expect(screen.getAllByText(/^2026\/10\/28 12:30/)).toHaveLength(2);
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

describe("GridCell: a reference to another record is a link to its page (rule 21)", () => {
  const supplier = "0199a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
  const ref = (over: Partial<GridColumn> = {}) => column({ field: "supplier_id", label: "Proveedor", type: "ref", kind: "uuid", ref: { entity: "core.party", display: "legal_name" }, linkable: true, ...over });

  it("shows the referenced record's name, from the row's <field>_label, as a link to its page that does not open the row", () => {
    const onRow = vi.fn();
    renderEs(
      <table>
        <tbody>
          <tr onClick={onRow}>
            <GridCell column={ref()} row={{ id: "1", supplier_id: supplier, supplier_id_label: "Café del Norte S.A.S." }} />
          </tr>
        </tbody>
      </table>,
    );
    const link = screen.getByRole("link", { name: "Café del Norte S.A.S." });
    expect(link.getAttribute("href")).toBe(`/r/core.party/${supplier}`);
    expect(link.getAttribute("title")).toBe("Abrir Café del Norte S.A.S.");
    // Out of the tab order: the row is the grid's one tab stop and Enter opens it.
    expect(link.getAttribute("tabindex")).toBe("-1");
    fireEvent.click(link);
    expect(onRow).not.toHaveBeenCalled();
  });

  it("moves client-side through the shell's navigation on a plain click, and leaves a Ctrl/⌘-click to the browser", () => {
    const navigate = vi.fn();
    renderEs(
      <NavigateProvider navigate={navigate}>
        {inRow(<GridCell column={ref()} row={{ id: "1", supplier_id: supplier, supplier_id_label: "Café del Norte S.A.S." }} />)}
      </NavigateProvider>,
    );
    const link = screen.getByRole("link", { name: "Café del Norte S.A.S." });
    const plain = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith(`/r/core.party/${supplier}`);
    const modified = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    link.dispatchEvent(modified);
    expect(modified.defaultPrevented).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("links a user to their page under Administración › Usuarios, and names a record without a label by its short id", () => {
    const user = "0199a2b3-0000-7000-8000-000000000001";
    renderEs(inRow(<GridCell column={ref({ field: "reporter_user_id", ref: { entity: "kernel.user", display: "full_name" } })} row={{ id: "1", reporter_user_id: user }} />));
    const link = screen.getByRole("link", { name: "0199a2b3" });
    expect(link.getAttribute("href")).toBe(`/admin/users/${user}`);
    expect(link.className).toContain("erp-mono");
  });

  it("takes the name from the column's options when the row has no label (a category)", () => {
    renderEs(inRow(<GridCell column={ref({ field: "category_id", ref: { entity: "core.product_category", display: "name" }, options: [{ value: "c1", label: "Café" }] })} row={{ id: "1", category_id: "c1" }} />));
    expect(screen.getByRole("link", { name: "Café" }).getAttribute("href")).toBe("/r/core.product_category/c1");
  });

  it("is plain text when the viewer may not open the referenced record, a dash when empty, and stays •••••• when masked", () => {
    renderEs(
      <>
        {inRow(<GridCell column={ref({ linkable: false })} row={{ id: "1", supplier_id: supplier, supplier_id_label: "Café del Norte S.A.S." }} />)}
        {inRow(<GridCell column={ref({ field: "other_id" })} row={{ id: "2", other_id: null }} />)}
        {inRow(<GridCell column={ref({ field: "secret_id", mode: "masked" })} row={{ id: "3", secret_id: null, secret_id_label: "Oculto" }} />)}
      </>,
    );
    expect(screen.getByText("Café del Norte S.A.S.").closest("a")).toBeNull();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("••••••")).toBeTruthy();
    expect(screen.queryByText("Oculto")).toBeNull();
  });
});

describe("GridCell · empty lists", () => {
  it("says 'Ninguno' (with the column in its tooltip) for an empty list, and counts a filled one", () => {
    const other = column({ field: "other_taxes", label: "Otros impuestos", type: "json", kind: "json" });
    renderEs(
      <>
        {inRow(<GridCell column={other} row={{ id: "1", other_taxes: [] }} />)}
        {inRow(<GridCell column={other} row={{ id: "2", other_taxes: [{ a: 1 }, { a: 2 }] }} />)}
      </>,
    );
    expect(screen.getByText("Ninguno").getAttribute("title")).toBe("Otros impuestos: ninguno definido");
    expect(screen.getByText("2 elementos")).toBeTruthy();
  });

  it("a posted comprobante that was reversed shows «Revertido» in red instead of its state", () => {
    const status = column({ field: "status", type: "enum", kind: "enum", options: [{ value: "posted", label: "Contabilizado" }], pills: { posted: "ok" }, marked: { field: "reversed_by_id", whenValue: "posted", label: "Revertido", tone: "danger" } });
    renderEs(
      <>
        {inRow(<GridCell column={status} row={{ id: "1", status: "posted", reversed_by_id: "e2" }} />)}
        {inRow(<GridCell column={status} row={{ id: "2", status: "posted", reversed_by_id: null }} />)}
      </>,
    );
    const reversed = screen.getByText("Revertido");
    expect(reversed.className).toContain("erp-pill--danger");
    expect(screen.getByText("Contabilizado").className).toContain("erp-pill--ok");
  });
});
