// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { Dashboard, type DashboardWidget } from "../Dashboard";
import { homeStorageKey, type WidgetLayout } from "../home-model";
import { memoryStorage, renderEs } from "../../shell/__tests__/intl";

// The home dashboard (design §19a, rule 25, prototype `wgStart/wgOver/wgDrop/wgResize`): widgets are dragged by their
// header to relocate and by the corner to resize (1–4 columns, free height), the layout is the user's own and
// resettable, and a layout the browser or the server hands back is only trusted when it is valid.

afterEach(cleanup);

const five: WidgetLayout[] = [
  { id: "w1", w: 1, h: 200 },
  { id: "w2", w: 1, h: 200 },
  { id: "w3", w: 2, h: 200 },
  { id: "w4", w: 4, h: 240 },
  { id: "w5", w: 4, h: 240 },
];
const widgets: DashboardWidget[] = five.map((w, i) => ({ id: w.id, title: `Tarjeta ${i + 1}`, content: <p>cuerpo {i + 1}</p> }));

const dataTransfer = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: "", dropEffect: "" });
const region = (n: number) => screen.getByRole("region", { name: `Tarjeta ${n}` });
const handle = (n: number) => region(n).querySelector<HTMLElement>("[draggable='true']")!;
/** Titles in the order they are on the page. */
const order = () => screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"));

function mount(props: Partial<Parameters<typeof Dashboard>[0]> = {}) {
  const storage = props.storage === undefined ? memoryStorage() : props.storage;
  const onChange = vi.fn();
  const element = (extra: Partial<Parameters<typeof Dashboard>[0]> = {}) => (
    <Dashboard userId="u1" companyId="c1" widgets={widgets} defaultLayout={five} initial={null} storage={storage} onChange={onChange} {...props} {...extra} />
  );
  const view = renderEs(element());
  return { ...view, storage, onChange, remount: (extra?: Partial<Parameters<typeof Dashboard>[0]>) => { view.unmount(); return renderEs(element(extra)); } };
}

function drag(from: number, to: number) {
  const transfer = dataTransfer();
  fireEvent.dragStart(handle(from), { dataTransfer: transfer });
  fireEvent.dragOver(region(to), { dataTransfer: transfer });
  fireEvent.drop(region(to), { dataTransfer: transfer });
  fireEvent.dragEnd(handle(from), { dataTransfer: transfer });
}

/** The grid is 1212 px wide in these tests: four columns of 294 px and three 12 px gaps. */
function sizeGrid() {
  Object.defineProperty(screen.getByTestId("dashboard-grid"), "clientWidth", { configurable: true, value: 1212 });
}
function resize(n: number, dx: number, dy: number) {
  const grip = within(region(n)).getByRole("button", { name: `Cambiar tamaño de Tarjeta ${n}` });
  fireEvent.pointerDown(grip, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerMove(document, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
  fireEvent.pointerUp(document, { clientX: 100 + dx, clientY: 100 + dy, pointerId: 1 });
}

describe("Dashboard", () => {
  it("renders the widgets in the default layout with their span and height", () => {
    mount();
    expect(order()).toEqual(["Tarjeta 1", "Tarjeta 2", "Tarjeta 3", "Tarjeta 4", "Tarjeta 5"]);
    expect(region(3).style.gridColumn).toBe("span 2");
    expect(region(4).style.minHeight).toBe("240px");
    expect(within(region(3)).getByText("2/4 · 200 px")).toBeTruthy();
  });

  it("dropping widget 5 on slot 1 reorders and persists", () => {
    const { onChange, storage } = mount();
    drag(5, 1);
    expect(order()).toEqual(["Tarjeta 5", "Tarjeta 1", "Tarjeta 2", "Tarjeta 3", "Tarjeta 4"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    const [layout, savedAt] = onChange.mock.calls[0]!;
    expect((layout as WidgetLayout[]).map((w) => w.id)).toEqual(["w5", "w1", "w2", "w3", "w4"]);
    expect(savedAt).toEqual(expect.any(Number));
    expect(JSON.parse(storage!.getItem(homeStorageKey("u1"))!)).toMatchObject({ companyId: "c1", value: layout });
  });

  it("dropping a widget on itself changes and saves nothing", () => {
    const { onChange } = mount();
    drag(2, 2);
    expect(onChange).not.toHaveBeenCalled();
    expect(order()[1]).toBe("Tarjeta 2");
  });

  it("marks the widget being dragged and the one it is over, and clears both at the end", () => {
    mount();
    const transfer = dataTransfer();
    fireEvent.dragStart(handle(3), { dataTransfer: transfer });
    expect(region(3).getAttribute("data-dragging")).toBe("true");
    fireEvent.dragOver(region(1), { dataTransfer: transfer });
    expect(region(1).getAttribute("data-over")).toBe("true");
    fireEvent.dragEnd(handle(3), { dataTransfer: transfer });
    expect(region(3).getAttribute("data-dragging")).toBeNull();
    expect(region(1).getAttribute("data-over")).toBeNull();
  });

  it("resizing to span 2 persists and survives reload", () => {
    const { onChange, remount } = mount();
    sizeGrid();
    resize(1, 294 + 12, 70);
    expect(region(1).style.gridColumn).toBe("span 2");
    expect(region(1).style.minHeight).toBe("270px");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((onChange.mock.calls[0]![0] as WidgetLayout[])[0]).toEqual({ id: "w1", w: 2, h: 270 });
    // A reload: nothing from the server yet (the save may still be on its way), the browser cache brings it back.
    remount();
    expect(region(1).style.gridColumn).toBe("span 2");
    expect(region(1).style.minHeight).toBe("270px");
  });

  it("a layout saved on the server is shown after a reload, a newer browser copy wins and is saved again", () => {
    const storage = memoryStorage();
    const server = { value: [{ id: "w2", w: 4, h: 300 }, { id: "w1", w: 1, h: 200 }, { id: "w3", w: 2, h: 200 }, { id: "w4", w: 4, h: 240 }, { id: "w5", w: 4, h: 240 }], savedAt: 1000 };
    const first = mount({ storage, initial: server });
    expect(order().slice(0, 2)).toEqual(["Tarjeta 2", "Tarjeta 1"]);
    expect(first.onChange).not.toHaveBeenCalled();
    first.unmount();
    // The browser holds a newer copy the server never received.
    const newer = [{ id: "w5", w: 1, h: 200 }, ...five.filter((w) => w.id !== "w5")];
    storage.setItem(homeStorageKey("u1"), JSON.stringify({ value: newer, savedAt: 5000, companyId: "c1" }));
    const second = mount({ storage, initial: server });
    expect(order()[0]).toBe("Tarjeta 5");
    expect(second.onChange).toHaveBeenCalledWith(newer, 5000);
  });

  it("an unknown widget id in saved prefs falls back to the default layout", () => {
    mount({ initial: { value: [{ id: "ghost", w: 1, h: 200 }, { id: "w1", w: 1, h: 200 }], savedAt: 10 } });
    expect(order()).toEqual(["Tarjeta 1", "Tarjeta 2", "Tarjeta 3", "Tarjeta 4", "Tarjeta 5"]);
    expect(region(3).style.gridColumn).toBe("span 2");
  });

  it("ignores another company's cached layout", () => {
    const storage = memoryStorage();
    storage.setItem(homeStorageKey("u1"), JSON.stringify({ value: [{ id: "w5", w: 1, h: 200 }, ...five.filter((w) => w.id !== "w5")], savedAt: 5000, companyId: "otra" }));
    mount({ storage });
    expect(order()[0]).toBe("Tarjeta 1");
  });

  it("Restablecer tarjetas goes back to the default layout and saves that", () => {
    const { onChange } = mount();
    drag(5, 1);
    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Restablecer tarjetas" }));
    expect(order()).toEqual(["Tarjeta 1", "Tarjeta 2", "Tarjeta 3", "Tarjeta 4", "Tarjeta 5"]);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual(five);
  });

  it("works from the keyboard: Alt+arrows move a widget, arrows on the corner resize it", () => {
    const { onChange } = mount();
    fireEvent.keyDown(handle(2), { key: "ArrowLeft", altKey: true });
    expect(order().slice(0, 2)).toEqual(["Tarjeta 2", "Tarjeta 1"]);
    const grip = within(region(2)).getByRole("button", { name: "Cambiar tamaño de Tarjeta 2" });
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(region(2).style.gridColumn).toBe("span 2");
    fireEvent.keyDown(grip, { key: "ArrowDown" });
    expect(region(2).style.minHeight).toBe("240px");
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("shows a widget the page does not offer nowhere, without losing its place in the saved layout", () => {
    const { onChange } = mount({ widgets: widgets.filter((w) => w.id !== "w3") });
    expect(order()).toEqual(["Tarjeta 1", "Tarjeta 2", "Tarjeta 4", "Tarjeta 5"]);
    drag(5, 4);
    const layout = onChange.mock.calls[0]![0] as WidgetLayout[];
    expect(layout.map((w) => w.id)).toEqual(["w1", "w2", "w3", "w5", "w4"]);
  });
});
