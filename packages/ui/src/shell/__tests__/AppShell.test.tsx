// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { AppShell } from "../AppShell";
import type { NavItem } from "../types";
import { renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

const nav: NavItem[] = [
  { id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" },
  { id: "core.products", label: "nav.core.products", href: "/products", icon: "package" },
  { id: "core.categories", label: "nav.core.categories", href: "/categories", icon: "tags" },
];

function shell(currentHref: string, navigate = vi.fn(), extra: Partial<Parameters<typeof AppShell>[0]> = {}) {
  const company = { id: "c1", name: "Café del Norte S.A.S.", taxId: "900373115" };
  return renderEs(
    <AppShell
      company={company}
      companies={[company]}
      user={{ id: "u1", name: "Laura Martínez", email: "laura@demo.local", roles: ["admin"] }}
      modules={[{ id: "core", label: "nav.modules.core" }]}
      nav={nav}
      currentHref={currentHref}
      navigate={navigate}
      {...extra}
    >
      <p>contenido</p>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("shows the active module's items next to the module button, the current one marked", () => {
    shell("/parties");
    expect(screen.getByRole("button", { name: "Módulos" }).textContent).toContain("Núcleo");
    const items = within(screen.getByRole("navigation", { name: "Menú del módulo" })).getAllByRole("button");
    expect(items.map((b) => b.textContent)).toEqual(["Inicio", "Terceros", "Productos", "Categorías"]);
    expect(items[1]!.getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("LM")).toBeTruthy();
  });

  it("the page being shown opens its tab, and a module item navigates", () => {
    const navigate = vi.fn();
    shell("/parties", navigate);
    const tabs = screen.getByRole("navigation", { name: "Pestañas abiertas" });
    expect(within(tabs).getByRole("button", { name: "Terceros" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Menú del módulo" })).getByRole("button", { name: "Productos" }));
    expect(navigate).toHaveBeenCalledWith("/products");
  });

  it("closing the active tab navigates to its neighbour", () => {
    const navigate = vi.fn();
    shell("/parties", navigate);
    fireEvent.click(screen.getByRole("button", { name: "Cerrar Terceros" }));
    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("applies the saved theme and reports a change", () => {
    const onThemeChange = vi.fn();
    shell("/", vi.fn(), { theme: "dark", onThemeChange });
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Cambiar tema" }));
    expect(onThemeChange).toHaveBeenCalledWith("auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });

  it("the Asistente button toggles the 400 px drawer, ⌘K text opens it with the question", () => {
    shell("/");
    expect(screen.getByRole("complementary", { name: "Asistente" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Asistente" }));
    expect(screen.queryByRole("complementary", { name: "Asistente" })).toBeNull();
    fireEvent.click(screen.getByLabelText("Comando"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "ventas de la semana por vendedor" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    const drawer = screen.getByRole("complementary", { name: "Asistente" });
    expect(drawer.textContent).toContain("ventas de la semana por vendedor");
  });

  it("restores the server's tabs", () => {
    shell("/", vi.fn(), { initialTabs: { tabs: [{ id: "/products", title: "Productos", href: "/products", kind: "grid" }], activeId: "/products" } });
    const tabs = screen.getByRole("navigation", { name: "Pestañas abiertas" });
    expect(within(tabs).getByRole("button", { name: "Productos" })).toBeTruthy();
    expect(within(tabs).getByRole("button", { name: "Inicio" }).getAttribute("aria-current")).toBe("page");
  });
});
