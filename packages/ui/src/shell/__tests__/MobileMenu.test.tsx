// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { MobileMenu } from "../MobileMenu";
import { renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// Shell v7 (owner 2026-11-02, design §22.24, rule 19): under 1024 px the side menu becomes the "Menú" sheet, with the module names
// only; the active module's sections stay in the bar.
const modules = [{ id: "core", label: "nav.modules.core" }, { id: "kernel", label: "nav.modules.kernel" }];

function setup() {
  const onSelectModule = vi.fn();
  renderEs(<MobileMenu modules={modules} activeModuleId="core" onSelectModule={onSelectModule} />);
  return { onSelectModule };
}

describe("MobileMenu", () => {
  it("lists the module names only, the active one marked", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Menú de navegación" }));
    const dialog = screen.getByRole("dialog");
    const entries = within(within(dialog).getByRole("navigation", { name: "Módulos" })).getAllByRole("button");
    expect(entries.map((b) => b.textContent)).toEqual(["Núcleo", "Sistema"]);
    expect(entries[0]!.getAttribute("aria-current")).toBe("true");
    expect(within(dialog).queryAllByRole("link")).toEqual([]);
  });

  it("picking a module selects it and closes the sheet", () => {
    const { onSelectModule } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Menú de navegación" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Sistema" }));
    expect(onSelectModule).toHaveBeenCalledWith("kernel");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
