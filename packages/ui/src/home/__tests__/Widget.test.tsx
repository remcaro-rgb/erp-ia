// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { Widget, type WidgetProps } from "../Widget";
import { renderEs } from "../../shell/__tests__/intl";

// Phase 1b task 1 (audit §2.28, L9): the header is a real button; Enter or Space opens a "Mover" mode where the arrows move
// the card and Shift + arrows resize it, Esc leaves it, and the hint is on screen while it lasts.

afterEach(cleanup);

function setup(extra: Partial<WidgetProps> = {}) {
  const handlers = { onMoveKey: vi.fn(), onResizeKey: vi.fn(), onDragStart: vi.fn(), onDragEnd: vi.fn(), onDragOver: vi.fn(), onDragLeave: vi.fn(), onDrop: vi.fn(), onResizeStart: vi.fn() };
  renderEs(
    <Widget title="Indicadores" columns={2} height={200} dragging={false} over={false} resizing={false} {...handlers} {...extra}>
      <p>cuerpo</p>
    </Widget>,
  );
  const header = screen.getByRole("button", { name: "Mover Indicadores" });
  return { ...handlers, header };
}

const hint = () => screen.queryByRole("status");

describe("Widget header", () => {
  it("is a real <button>, draggable, with the Alt+arrows shortcut advertised", () => {
    const { header } = setup();
    expect(header.tagName).toBe("BUTTON");
    expect(header.getAttribute("type")).toBe("button");
    expect(header.getAttribute("draggable")).toBe("true");
    expect(header.getAttribute("aria-keyshortcuts")).toContain("Alt+ArrowLeft");
    expect(header.getAttribute("aria-pressed")).toBe("false");
  });

  it.each(["Enter", " "])("%j opens the Mover mode: pressed, hint visible", (key) => {
    const { header } = setup();
    expect(hint()?.textContent ?? "").toBe("");
    fireEvent.keyDown(header, { key });
    expect(header.getAttribute("aria-pressed")).toBe("true");
    expect(hint()?.textContent).toMatch(/Modo mover/);
    expect(hint()?.textContent).toMatch(/flechas/i);
    expect(hint()?.textContent).toMatch(/Esc/);
    expect(screen.getByRole("region", { name: "Indicadores" }).getAttribute("data-moving")).toBe("true");
  });

  it("in the mode the arrows move the card (← ↑ earlier, → ↓ later) and Shift + arrows resize it", () => {
    const { header, onMoveKey, onResizeKey } = setup();
    fireEvent.keyDown(header, { key: "Enter" });
    fireEvent.keyDown(header, { key: "ArrowLeft" });
    fireEvent.keyDown(header, { key: "ArrowUp" });
    expect(onMoveKey.mock.calls).toEqual([[-1], [-1]]);
    fireEvent.keyDown(header, { key: "ArrowRight" });
    fireEvent.keyDown(header, { key: "ArrowDown" });
    expect(onMoveKey.mock.calls.slice(2)).toEqual([[1], [1]]);
    fireEvent.keyDown(header, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(header, { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(header, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(header, { key: "ArrowUp", shiftKey: true });
    expect(onResizeKey.mock.calls).toEqual([[1, 0], [-1, 0], [0, 1], [0, -1]]);
    expect(onMoveKey).toHaveBeenCalledTimes(4);
  });

  it("Esc leaves the mode (and the arrows stop moving); Enter again leaves it too", () => {
    const { header, onMoveKey } = setup();
    fireEvent.keyDown(header, { key: "Enter" });
    fireEvent.keyDown(header, { key: "Escape" });
    expect(header.getAttribute("aria-pressed")).toBe("false");
    expect(hint()?.textContent ?? "").toBe("");
    fireEvent.keyDown(header, { key: "ArrowRight" });
    expect(onMoveKey).not.toHaveBeenCalled();
    fireEvent.keyDown(header, { key: "Enter" });
    fireEvent.keyDown(header, { key: "Enter" });
    expect(header.getAttribute("aria-pressed")).toBe("false");
  });

  it("outside the mode plain arrows do nothing and Alt+arrows still move the card", () => {
    const { header, onMoveKey } = setup();
    fireEvent.keyDown(header, { key: "ArrowRight" });
    expect(onMoveKey).not.toHaveBeenCalled();
    fireEvent.keyDown(header, { key: "ArrowLeft", altKey: true });
    expect(onMoveKey).toHaveBeenCalledWith(-1);
  });

  it("the mode ends when the caret goes to another control, but not when the card is moved under it", () => {
    const { header } = setup();
    fireEvent.keyDown(header, { key: "Enter" });
    // The DOM node being moved blurs it without a target: the mode stays.
    fireEvent.blur(header, { relatedTarget: null });
    expect(header.getAttribute("aria-pressed")).toBe("true");
    fireEvent.blur(header, { relatedTarget: screen.getByRole("button", { name: "Cambiar tamaño de Indicadores" }) });
    expect(header.getAttribute("aria-pressed")).toBe("false");
  });

  it("the size hint is shown while in the mode (data-moving) and still hidden from the accessibility tree", () => {
    const { header } = setup();
    fireEvent.keyDown(header, { key: "Enter" });
    const size = header.querySelector(".erp-wg__size")!;
    expect(size.textContent).toContain("2/4");
    expect(size.getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps dragging from the header", () => {
    const { header, onDragStart } = setup();
    fireEvent.dragStart(header);
    expect(onDragStart).toHaveBeenCalled();
  });
});
