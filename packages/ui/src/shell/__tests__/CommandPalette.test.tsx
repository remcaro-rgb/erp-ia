// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { CommandPalette } from "../CommandPalette";
import type { CommandItem } from "../types";
import { renderEs, stubLayoutApis } from "./intl";

const items: CommandItem[] = [
  { id: "go:core.parties", label: "Ir a Terceros", kind: "go", href: "/parties", keywords: ["clientes", "proveedores", "nit"] },
  { id: "go:core.products", label: "Ir a Productos", kind: "go", href: "/products", keywords: ["servicios"] },
  { id: "create:core.party.create", label: "Crear tercero", kind: "create", href: "/parties?new=1" },
];

beforeAll(stubLayoutApis);
afterEach(cleanup);

const openWithShortcut = (init: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true }) =>
  act(() => {
    fireEvent.keyDown(document, { key: "k", ...init });
  });

describe("CommandPalette", () => {
  it("opens with ⌘K and with Ctrl+K", () => {
    renderEs(<CommandPalette items={items} onAsk={() => {}} onSelect={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    openWithShortcut();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    openWithShortcut({ ctrlKey: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("typing “clientes” lists the Parties navigation item (by its keywords) and nothing unrelated", () => {
    renderEs(<CommandPalette items={items} onAsk={() => {}} onSelect={() => {}} />);
    openWithShortcut();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "clientes" } });
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options.some((text) => text?.includes("Ir a Terceros"))).toBe(true);
    expect(options.some((text) => text?.includes("Productos"))).toBe(false);
  });

  it("matching ignores accents and case", () => {
    renderEs(<CommandPalette items={items} onAsk={() => {}} onSelect={() => {}} />);
    openWithShortcut();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "TÉRCEROS" } });
    expect(screen.getAllByRole("option").some((o) => o.textContent?.includes("Ir a Terceros"))).toBe(true);
  });

  it("Enter on a match runs it", () => {
    const onSelect = vi.fn();
    renderEs(<CommandPalette items={items} onAsk={() => {}} onSelect={onSelect} />);
    openWithShortcut();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "clientes" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(items[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter on free text calls onAsk with the text", () => {
    const onAsk = vi.fn();
    const onSelect = vi.fn();
    renderEs(<CommandPalette items={items} onAsk={onAsk} onSelect={onSelect} />);
    openWithShortcut();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "¿cuánto vendimos esta semana?" } });
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("Preguntar al asistente");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onAsk).toHaveBeenCalledWith("¿cuánto vendimos esta semana?");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a sentence of more than two words offers the assistant first even when something matches", () => {
    renderEs(<CommandPalette items={items} onAsk={() => {}} onSelect={() => {}} />);
    openWithShortcut();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "crear tercero nuevo" } });
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("Preguntar al asistente");
  });
});

describe("CommandPalette keyboard (T2 review)", () => {
  it("exactly one option is active; the arrows move it and Enter runs the active one; Esc closes", () => {
    const onSelect = vi.fn();
    renderEs(<CommandPalette items={items} onAsk={() => {}} onSelect={onSelect} />);
    openWithShortcut();
    const active = () => screen.getAllByRole("option").filter((o) => o.getAttribute("aria-selected") === "true");
    expect(active()).toHaveLength(1);
    const first = active()[0]!.textContent;
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(active()).toHaveLength(1);
    expect(active()[0]!.textContent).not.toBe(first);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
    openWithShortcut();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
