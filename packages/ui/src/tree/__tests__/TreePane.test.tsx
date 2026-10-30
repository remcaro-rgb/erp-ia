// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { TreePane, type TreeItem } from "../TreePane";

beforeAll(stubLayoutApis);
afterEach(cleanup);

const items: TreeItem[] = [
  { id: "c1", parentId: null, code: "1", name: "Activo", figure: 4_500_000 },
  { id: "g13", parentId: "c1", code: "13", name: "Deudores", figure: 1_500_000 },
  { id: "a1305", parentId: "g13", code: "1305", name: "Clientes", figure: 1_500_000 },
  { id: "c5", parentId: null, code: "5", name: "Gastos", figure: 250_000 },
  { id: "g51", parentId: "c5", code: "51", name: "Operacionales de administración", restricted: true },
];

const row = (name: RegExp) => screen.getByRole("treeitem", { name });

describe("TreePane", () => {
  it("shows the figure beside each node, a lock without figure on a restricted node, and filters by code or name", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderEs(<TreePane items={items} selectedId={null} onSelect={onSelect} label="Árbol de Plan de cuentas" figureLabel="Saldo" />);

    // Two levels are open at first: the classes and the groups show.
    const activo = row(/^1 Activo/);
    expect(within(activo).getByText("$ 4.500.000,00")).toBeTruthy();
    expect(within(row(/^13 Deudores/)).getByText("$ 1.500.000,00")).toBeTruthy();

    // The restricted group shows the lock and no amount at all.
    const restricted = row(/^51 Operacionales/);
    expect(within(restricted).getByRole("img", { name: "Cuenta restringida" })).toBeTruthy();
    expect(restricted.querySelector(".erp-tree__figure")).toBeNull();

    // The search matches the code and the name, with the path to the match open.
    await user.type(screen.getByRole("searchbox", { name: "Buscar por código o descripción" }), "clientes");
    expect(screen.getAllByRole("treeitem").map((n) => n.getAttribute("aria-level"))).toEqual(["1", "2", "3"]);
    expect(row(/^1305 Clientes/)).toBeTruthy();
    expect(screen.queryByRole("treeitem", { name: /^5 Gastos/ })).toBeNull();
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "51");
    expect(row(/^51 Operacionales/)).toBeTruthy();

    // Clicking a node selects it.
    await user.click(row(/^51 Operacionales/));
    expect(onSelect).toHaveBeenCalledWith("g51");
  });

  it("moves with the arrows, opens with right, closes with left and selects with Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderEs(<TreePane items={items} selectedId={null} onSelect={onSelect} label="Árbol" initialLevel={0} />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);

    row(/^1 Activo/).focus();
    await user.keyboard("{ArrowRight}");
    expect(row(/^1 Activo/).getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{ArrowRight}");
    await vi.waitFor(() => expect(document.activeElement).toBe(row(/^13 Deudores/)));
    await user.keyboard("{ArrowLeft}");
    await vi.waitFor(() => expect(document.activeElement).toBe(row(/^1 Activo/)));
    await user.keyboard("{ArrowLeft}");
    expect(row(/^1 Activo/).getAttribute("aria-expanded")).toBe("false");
    await user.keyboard("{ArrowDown}");
    await vi.waitFor(() => expect(document.activeElement).toBe(row(/^5 Gastos/)));
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("c5");
  });

  it("the level buttons open the tree to that level", async () => {
    const user = userEvent.setup();
    renderEs(<TreePane items={items} selectedId={null} onSelect={() => {}} label="Árbol" initialLevel={0} levels={3} />);
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Abrir hasta el nivel 3" }));
    expect(screen.getAllByRole("treeitem")).toHaveLength(5);
  });
});
