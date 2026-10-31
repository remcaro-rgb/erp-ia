// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

const router = vi.hoisted(() => ({ push: () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));

const { BACK_WALK_MS, goBackPast, guardedNavigate, useLeaveGuard } = await import("./leave-guard");

// Back from a screen with staged changes goes past every entry of that screen: the guard leaves a spent entry of the
// same URL behind, and a reload can make the next guard push a second one (production build).

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function stack(paths: string[]) {
  for (const path of paths) {
    window.history.pushState({}, "", path);
    await settle(5);
  }
}

describe("goBackPast", () => {
  it("goes back the given steps when that already leaves the screen", async () => {
    await stack(["/home", "/admin/fields", "/admin/fields"]);
    goBackPast(2);
    await settle();
    expect(window.location.pathname).toBe("/home");
  });

  it("goes on past the entries of the same screen a reload left behind", async () => {
    await stack(["/inicio", "/admin/fields", "/admin/fields", "/admin/fields"]);
    goBackPast(2);
    await settle(150);
    expect(window.location.pathname).toBe("/inicio");
  });

  it("stops after a few extra steps instead of walking the whole history", async () => {
    await stack(["/otra", ...Array.from({ length: 9 }, () => "/admin/fields")]);
    goBackPast(2);
    await settle(300);
    expect(window.location.pathname).toBe("/admin/fields");
  });
});

describe("the walk's popstate listener never dangles", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The popstate listeners added and removed from here on, with history.go held (no step ever comes). */
  const watch = () => {
    vi.spyOn(window.history, "go").mockImplementation(() => {});
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    const popAdded = () => added.mock.calls.filter(([type]) => type === "popstate").map(([, fn]) => fn);
    const popRemoved = () => removed.mock.calls.filter(([type]) => type === "popstate").map(([, fn]) => fn);
    return { popAdded, popRemoved };
  };

  it("is dropped after BACK_WALK_MS when no step comes", () => {
    vi.useFakeTimers();
    const { popAdded, popRemoved } = watch();
    goBackPast(2);
    const [listener] = popAdded();
    expect(listener).toBeDefined();
    vi.advanceTimersByTime(BACK_WALK_MS - 1);
    expect(popRemoved()).not.toContain(listener);
    vi.advanceTimersByTime(1);
    expect(popRemoved()).toContain(listener);
    expect(BACK_WALK_MS).toBeLessThanOrEqual(1000);
  });

  it("is dropped at once by the stop function it answers", () => {
    const { popAdded, popRemoved } = watch();
    const stop = goBackPast(2);
    const [listener] = popAdded();
    stop();
    expect(popRemoved()).toContain(listener);
  });

  it("is dropped by the guard as the screen unmounts", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const Screen = () => useLeaveGuard(1);
    await act(async () => root.render(createElement(Screen)));
    const { popAdded, popRemoved } = watch();
    // Back from the guard's entry asks; "Salir sin aplicar" starts the walk back past the screen.
    await act(async () => void window.dispatchEvent(new PopStateEvent("popstate", { state: {} })));
    const leave = [...host.querySelectorAll("button")].find((b) => b.textContent === "common.admin.leave_go")!;
    expect(leave).toBeDefined();
    const before = popAdded().length;
    await act(async () => leave.click());
    const walk = popAdded().slice(before);
    expect(walk).toHaveLength(1);
    expect(popRemoved()).not.toContain(walk[0]);
    await act(async () => root.unmount());
    expect(popRemoved()).toContain(walk[0]);
    host.remove();
  });
});

describe("the guard of a form with unsaved changes (UX-OD-4, T8)", () => {
  const mount = async (save: () => Promise<boolean>) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const Screen = () => useLeaveGuard(1, { save });
    await act(async () => root.render(createElement(Screen)));
    return { host, root };
  };
  const buttons = (host: HTMLElement) => [...host.querySelectorAll("button")].map((b) => b.textContent);

  it("asks Guardar · Descartar · Cancelar when a navigation is held back, and the browser's own prompt on refresh", async () => {
    const { host, root } = await mount(async () => true);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    const go = vi.fn();
    guardedNavigate(go);
    await act(async () => {});
    expect(go).not.toHaveBeenCalled();
    expect(buttons(host)).toEqual(["common.unsaved.save", "common.unsaved.discard", "common.unsaved.cancel"]);
    await act(async () => root.unmount());
    host.remove();
  });

  it("Cancelar keeps the screen; Descartar leaves; Guardar leaves only when the save worked", async () => {
    const saves = [false, true];
    const { host, root } = await mount(async () => saves.shift()!);
    const click = async (label: string) => act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!.click());
    const go = vi.fn();
    guardedNavigate(go);
    await act(async () => {});
    await click("common.unsaved.cancel");
    expect(go).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alertdialog]")).toBeNull();
    guardedNavigate(go);
    await act(async () => {});
    await click("common.unsaved.save");
    expect(go).not.toHaveBeenCalled();
    expect(host.querySelector("[role=alertdialog]")).not.toBeNull();
    await click("common.unsaved.save");
    expect(go).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    host.remove();
  });

  it("Descartar leaves without saving", async () => {
    const save = vi.fn(async () => true);
    const { host, root } = await mount(save);
    const go = vi.fn();
    guardedNavigate(go);
    await act(async () => {});
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "common.unsaved.discard")!.click());
    expect(go).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    host.remove();
  });
});
