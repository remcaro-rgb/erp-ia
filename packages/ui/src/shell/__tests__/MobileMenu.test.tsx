// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { MobileMenu } from "../MobileMenu";
import type { NavItem } from "../types";
import { renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// UX-OD-1 (owner 2026-10-31): under 1024 px a "Menú" button opens a sheet with the Módulos and the active module's items.
const items: NavItem[] = [
  { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" },
  { id: "core.masters", label: "nav.core.products", href: "#", icon: "list", children: [{ id: "core.categories", label: "nav.core.categories", href: "/categories", icon: "tags" }] },
];
const modules = [{ id: "core", label: "nav.modules.core" }, { id: "kernel", label: "nav.modules.kernel" }];

function setup() {
  const onNavigate = vi.fn();
  const onSelectModule = vi.fn();
  renderEs(<MobileMenu modules={modules} itemsByModule={{ core: items, kernel: [] }} activeModuleId="core" onSelectModule={onSelectModule} activeHref="/parties" onNavigate={onNavigate} showHome />);
  return { onNavigate, onSelectModule };
}

describe("MobileMenu", () => {
  it("lists the modules and the active module's items, the groups expanded", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Menú de navegación" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent).filter((t) => /Núcleo|Sistema/.test(t ?? ""))).toEqual(["Núcleo", "Sistema"]);
    const links = within(dialog).getAllByRole("link").map((a) => a.textContent);
    expect(links).toEqual(["Inicio", "Terceros", "Categorías"]);
    expect(within(dialog).getByRole("link", { name: "Terceros" }).getAttribute("aria-current")).toBe("page");
  });

  it("a plain click on an item navigates and closes the sheet; picking a module selects it", () => {
    const { onNavigate, onSelectModule } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Menú de navegación" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("link", { name: "Categorías" }));
    expect(onNavigate).toHaveBeenCalledWith({ href: "/categories", title: "Categorías", kind: "grid" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Menú de navegación" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sistema" }));
    expect(onSelectModule).toHaveBeenCalledWith("kernel");
  });
});
