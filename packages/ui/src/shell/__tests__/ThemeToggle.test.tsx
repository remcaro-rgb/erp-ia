// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { ThemeToggle } from "../ThemeToggle";
import { applyTheme, nextTheme } from "../theme";
import { renderEs } from "./intl";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

describe("theme", () => {
  it("cycles auto → light → dark → auto", () => {
    expect(nextTheme("auto")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("auto");
  });

  it("applyTheme sets data-theme on <html>, and auto removes it so the system decides", () => {
    applyTheme("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    applyTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    applyTheme("auto");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("ThemeToggle", () => {
  it("each click moves to the next mode, sets data-theme and reports it for saving", () => {
    const onChange = vi.fn();
    renderEs(<ThemeToggle defaultMode="auto" onChange={onChange} />);
    const button = screen.getByRole("button", { name: "Cambiar tema" });
    expect(button.getAttribute("title")).toContain("automático");

    fireEvent.click(button);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(onChange).toHaveBeenLastCalledWith("light");
    expect(button.getAttribute("title")).toContain("claro");

    fireEvent.click(button);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(onChange).toHaveBeenLastCalledWith("dark");

    fireEvent.click(button);
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(onChange).toHaveBeenLastCalledWith("auto");
  });

  it("follows a controlled mode", () => {
    const { rerender } = renderEs(<ThemeToggle mode="dark" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Cambiar tema" }).getAttribute("title")).toContain("oscuro");
    rerender(<ThemeToggle mode="light" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Cambiar tema" }).getAttribute("title")).toContain("claro");
  });
});
