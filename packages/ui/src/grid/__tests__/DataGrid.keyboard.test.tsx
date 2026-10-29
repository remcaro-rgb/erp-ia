// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderEs } from "../../shell/__tests__/intl";
import { DataGrid } from "../DataGrid";
import type { GridColumn, GridFetcher, GridRow } from "../types";

afterEach(cleanup);

// UI density audit quick wins 4 (H2), 9 (M2-M4) and 16 (L10): the rows are ONE tab stop with arrow keys (WAI-ARIA
// roving tabindex), "/" jumps to the filters, and the header and footer never reflow while the grid works.

const columns: GridColumn[] = [
  { field: "legal_name", label: "Razón social", type: "text", kind: "text", mode: "visible", filterable: true, sortable: true },
  { field: "credit_limit", label: "Cupo", type: "money", kind: "number", mode: "visible", filterable: true, sortable: true },
];
const rows: GridRow[] = ["Almacenes Éxito S.A.", "Café del Norte S.A.S.", "Distribuidora Andina", "Ferretería El Tornillo"].map((legal_name, i) => ({
  id: `r${i}`,
  legal_name,
  credit_limit: String((i + 1) * 1000),
}));

const setup = () => {
  const fetcher = vi.fn<GridFetcher>(async () => ({ rows, total: 40 }));
  const onRowOpen = vi.fn();
  renderEs(<DataGrid entity="core.party" title="Terceros" columns={columns} fetcher={fetcher} onRowOpen={onRowOpen} debounceMs={20} />);
  return { fetcher, onRowOpen };
};
const bodyRows = () => [...document.querySelectorAll<HTMLTableRowElement>("tbody tr[data-row]")];

describe("DataGrid keyboard (roving tabindex)", () => {
  it("makes the rows one tab stop and keeps the row checkboxes out of the tab order", async () => {
    setup();
    await screen.findByText("Almacenes Éxito S.A.");
    expect(bodyRows().map((r) => r.tabIndex)).toEqual([0, -1, -1, -1]);
    for (const box of within(document.querySelector("tbody")!).getAllByRole("checkbox")) expect((box as HTMLInputElement).tabIndex).toBe(-1);
    // Tab from the last filter lands on the active row, and the next Tab leaves the rows.
    const user = userEvent.setup();
    screen.getByLabelText("Filtrar Cupo").focus();
    await user.tab();
    expect(document.activeElement).toBe(bodyRows()[0]);
    await user.tab();
    expect(document.activeElement?.closest("tbody")).toBeNull();
  });

  it("moves with ↑ ↓ Home End, selects with Space, opens with Enter, and ↑ on the first row goes to the filters", async () => {
    const { onRowOpen } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    const user = userEvent.setup();
    bodyRows()[0]!.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(bodyRows()[1]);
    expect(bodyRows().map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    await user.keyboard("{End}");
    expect(document.activeElement).toBe(bodyRows()[3]);
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(bodyRows()[3]);
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(bodyRows()[0]);
    await user.keyboard(" ");
    expect(bodyRows()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("1 seleccionada")).toBeTruthy();
    await user.keyboard(" ");
    expect(bodyRows()[0]!.getAttribute("aria-selected")).toBe("false");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onRowOpen).toHaveBeenCalledWith(rows[1]);
    await user.keyboard("{Home}{ArrowUp}");
    expect(document.activeElement).toBe(screen.getByLabelText("Filtrar Razón social"));
  });

  it("pages with PgDn and PgUp", async () => {
    const { fetcher } = setup();
    await screen.findByText("Almacenes Éxito S.A.");
    const user = userEvent.setup();
    bodyRows()[0]!.focus();
    await user.keyboard("{PageDown}");
    await waitFor(() => expect(fetcher.mock.calls.at(-1)![0].page).toBe(2));
    await waitFor(() => expect(document.querySelector(".erp-grid__ft")!.textContent).toContain("11–20"));
    bodyRows()[0]!.focus();
    await user.keyboard("{PageUp}");
    await waitFor(() => expect(fetcher.mock.calls.at(-1)![0].page).toBe(1));
  });

  it("'/' from the grid goes to the first filter, but types normally inside a text box", async () => {
    setup();
    await screen.findByText("Almacenes Éxito S.A.");
    const user = userEvent.setup();
    bodyRows()[2]!.focus();
    await user.keyboard("/");
    const first = screen.getByLabelText("Filtrar Razón social") as HTMLInputElement;
    expect(document.activeElement).toBe(first);
    await user.keyboard("a/b");
    expect(first.value).toBe("a/b");
  });

  it("explains the keys in the footer", async () => {
    setup();
    await screen.findByText("Almacenes Éxito S.A.");
    expect(screen.getByText("↑↓ moverse · Espacio seleccionar · Enter abrir · / filtrar")).toBeTruthy();
  });
});

describe("DataGrid stable header and footer", () => {
  it("always lays out the status slot and Limpiar filtros, hidden while there is nothing to clear", async () => {
    setup();
    await screen.findByText("Almacenes Éxito S.A.");
    const header = document.querySelector(".erp-grid__hd")!;
    const slot = header.querySelector(".erp-grid__status")!;
    expect(slot.getAttribute("role")).toBe("status");
    expect(slot.textContent).toBe("");
    const clear = header.querySelector<HTMLButtonElement>("button.erp-grid__clear")!;
    expect(clear.textContent).toBe("Limpiar filtros");
    expect(clear.disabled).toBe(true);
    expect(clear.getAttribute("aria-hidden")).toBe("true");
    expect(clear.className).toContain("is-reserved");
    fireEvent.change(screen.getByLabelText("Filtrar Razón social"), { target: { value: "caf" } });
    await waitFor(() => expect(clear.disabled).toBe(false));
    expect(clear.getAttribute("aria-hidden")).toBeNull();
    expect(clear.className).not.toContain("is-reserved");
    // The same nodes: nothing mounted or unmounted in the header.
    expect(header.querySelector(".erp-grid__status")).toBe(slot);
  });

  it("keeps the footer on one line: the selection appears inside the end group", async () => {
    setup();
    await screen.findByText("Almacenes Éxito S.A.");
    const end = document.querySelector(".erp-grid__ft .erp-grid__ft-end")!;
    const selection = end.querySelector(".erp-grid__selection")!;
    expect(selection.textContent).toBe("");
    fireEvent.click(within(bodyRows()[0]!).getByRole("checkbox"));
    expect(end.querySelector(".erp-grid__selection")).toBe(selection);
    expect(selection.textContent).toContain("1 seleccionada");
  });

  it("clears the Descarga lista status after 8 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("a;b", { status: 200, headers: { "content-disposition": 'attachment; filename="terceros.csv"' } })));
    try {
      setup();
      await screen.findByText("Almacenes Éxito S.A.");
      fireEvent.click(screen.getByRole("button", { name: "CSV" }));
      await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Descarga lista: terceros.csv"));
      // Let React run the effect that starts the 8 s timer before the clock moves.
      await act(async () => {});
      await act(async () => {
        vi.advanceTimersByTime(7_000);
      });
      expect(screen.getByRole("status").textContent).toBe("Descarga lista: terceros.csv");
      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(screen.getByRole("status").textContent).toBe("");
    } finally {
      vi.unstubAllGlobals();
      click.mockRestore();
      vi.useRealTimers();
    }
  });
});
