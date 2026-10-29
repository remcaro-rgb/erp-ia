// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ColumnChooser } from "../ColumnChooser";
import { SavedViewsMenu } from "../SavedViewsMenu";
import type { GridColumn } from "../types";
import type { SavedViewItem } from "../saved-views";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";

// Phase 1b task 1 (audit §2.13, §2.14): a popover takes the caret on open, gives it back to its button on Esc or when a
// choice closes it, closes when the caret leaves it, and deleting a saved view asks first, inline.

beforeAll(stubLayoutApis);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const col = (field: string, label: string): GridColumn => ({ field, label, type: "text", kind: "text", mode: "visible", filterable: true, sortable: true });
const columns = [col("name", "Razón social"), col("tax_id", "NIT"), col("city", "Municipio")];

const views: SavedViewItem[] = [
  { id: "v1", name: "Clientes Antioquia", isDefault: true, state: {} },
  { id: "v2", name: "Proveedores sin RUT", isDefault: false, state: {} },
];

function menu(extra: Partial<Parameters<typeof SavedViewsMenu>[0]> = {}) {
  const onDelete = vi.fn(async () => {});
  const onApply = vi.fn();
  renderEs(
    <div>
      <button type="button">antes</button>
      <SavedViewsMenu views={views} current={() => ({})} onSave={async () => {}} onDelete={onDelete} onApply={onApply} {...extra} />
      <button type="button">después</button>
    </div>,
  );
  return { onDelete, onApply, trigger: screen.getByRole("button", { name: "Guardar vista" }) };
}

describe("popover focus", () => {
  it("Columnas: the caret moves to the first checkbox on open and back to the button on Esc", () => {
    renderEs(<ColumnChooser columns={columns} shown={["name", "tax_id"]} onToggle={vi.fn()} onMove={vi.fn()} onReset={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: "Columnas" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(within(screen.getByRole("group", { name: "Columnas" })).getAllByRole("checkbox")[0]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Columnas" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Guardar vista: the caret goes to the first view's apply button; Esc closes and returns it to the trigger", () => {
    const { trigger } = menu();
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Aplicar la vista Clientes Antioquia" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Vistas" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("applying a view closes the panel and returns the caret to the trigger", () => {
    const { trigger, onApply } = menu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Aplicar la vista Proveedores sin RUT" }));
    expect(onApply).toHaveBeenCalledWith(views[1]);
    expect(screen.queryByRole("group", { name: "Vistas" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the caret leaves the panel (Tab out), without stealing it back", () => {
    const { trigger } = menu();
    fireEvent.click(trigger);
    const after = screen.getByRole("button", { name: "después" });
    act(() => after.focus());
    expect(screen.queryByRole("group", { name: "Vistas" })).toBeNull();
    expect(document.activeElement).toBe(after);
  });

  it("without views the caret goes to the name field", () => {
    const { trigger } = menu({ views: [] });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByLabelText("Nombre de la vista"));
  });
});

describe("deleting a saved view", () => {
  it("the ✕ asks '¿Eliminar {name}?' in place; nothing is deleted until that button is used", () => {
    const { trigger, onDelete } = menu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Borrar la vista Proveedores sin RUT" }));
    expect(onDelete).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "¿Eliminar Proveedores sin RUT?" });
    expect(document.activeElement).toBe(confirm);
    // The other view is untouched.
    expect(screen.getByRole("button", { name: "Borrar la vista Clientes Antioquia" })).toBeTruthy();
    fireEvent.click(confirm);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("v2");
    expect(screen.queryByRole("button", { name: /¿Eliminar/ })).toBeNull();
  });

  it("goes back to the ✕ by itself after 4 s, and arming one view disarms the other", () => {
    vi.useFakeTimers();
    const { trigger, onDelete } = menu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Borrar la vista Clientes Antioquia" }));
    fireEvent.click(screen.getByRole("button", { name: "Borrar la vista Proveedores sin RUT" }));
    expect(screen.queryByRole("button", { name: "¿Eliminar Clientes Antioquia?" })).toBeNull();
    expect(screen.getByRole("button", { name: "¿Eliminar Proveedores sin RUT?" })).toBeTruthy();
    act(() => void vi.advanceTimersByTime(4000));
    expect(screen.queryByRole("button", { name: /¿Eliminar/ })).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("Esc while a deletion is armed closes the panel; nothing was deleted", () => {
    const { trigger, onDelete } = menu();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Borrar la vista Clientes Antioquia" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Vistas" })).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });
});
