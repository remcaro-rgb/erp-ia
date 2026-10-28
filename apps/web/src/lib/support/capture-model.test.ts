import { describe, expect, it } from "vitest";
import { captured, describeError, emptyCapture, isSupportRoute, MAX_ERRORS, MAX_ERROR_LENGTH, MAX_SELECTION, withError, withRoute, withSelection } from "./capture-model";

// What a ticket carries about the screen it was filed from (design §8: route, selection, console errors). Pure
// rules; capture.ts wires them to the window.

describe("ticket context capture", () => {
  it("keeps the last route outside the support screen, because the ticket is about the screen the user came from", () => {
    let state = withRoute(emptyCapture(), "/parties");
    state = withRoute(state, "/support");
    state = withRoute(state, "/support?new=1");
    expect(state.route).toBe("/parties");
    expect(isSupportRoute("/support")).toBe(true);
    expect(isSupportRoute("/support/anything")).toBe(true);
    expect(isSupportRoute("/supporters")).toBe(false);
  });

  it("keeps the last non-empty selection made outside the support screen, trimmed and capped", () => {
    let state = withSelection(emptyCapture(), "  Almacenes Éxito  ", "/parties");
    expect(state.selection).toBe("Almacenes Éxito");
    state = withSelection(state, "", "/parties");
    expect(state.selection).toBe("Almacenes Éxito");
    state = withSelection(state, "escrito en el formulario", "/support");
    expect(state.selection).toBe("Almacenes Éxito");
    expect(withSelection(emptyCapture(), "x".repeat(MAX_SELECTION + 50), "/products").selection).toHaveLength(MAX_SELECTION);
  });

  it("keeps the most recent console errors, each bounded", () => {
    let state = emptyCapture();
    for (let i = 0; i < MAX_ERRORS + 5; i++) state = withError(state, `error ${i}`);
    expect(state.errors).toHaveLength(MAX_ERRORS);
    expect(state.errors[0]).toBe("error 5");
    expect(state.errors.at(-1)).toBe(`error ${MAX_ERRORS + 4}`);
    expect(withError(emptyCapture(), "y".repeat(MAX_ERROR_LENGTH + 10)).errors[0]).toHaveLength(MAX_ERROR_LENGTH);
    expect(withError(emptyCapture(), "   ").errors).toEqual([]);
  });

  it("describes what console.error and the error events receive", () => {
    expect(describeError(["Falló", 42, { a: 1 }])).toBe('Falló 42 {"a":1}');
    expect(describeError([new TypeError("x is undefined")])).toBe("TypeError: x is undefined");
    expect(describeError([])).toBe("");
  });

  it("bounds each argument before it is stringified, so a huge object or string costs nothing", () => {
    const huge = "z".repeat(1_000_000);
    expect(describeError([huge]).length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, i]));
    expect(describeError([wide]).length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => describeError([cyclic])).not.toThrow();
    expect(describeError([new Error("e".repeat(5000))]).length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
  });

  it("redacts the values of keys that look like secrets, in objects and in key=value text", () => {
    const text = describeError([{ user: "ana", token: "abc123", nested: { Password: "p4ss", ok: 1 }, headers: { Authorization: "Bearer xyz", cookie: "sid=1" }, client_secret: "s" }]);
    for (const leaked of ["abc123", "p4ss", "Bearer xyz", "sid=1", '"s"']) expect(text).not.toContain(leaked);
    expect(text).toContain("ana");
    expect(text).toContain("[redacted]");
    expect(describeError(["fetch failed: token=abc123 password: hunter2 for ana"])).toBe("fetch failed: token=[redacted] password: [redacted] for ana");
    expect(describeError(["Authorization: Bearer abc.def"])).not.toContain("abc.def");
  });

  it("builds the context the ticket process takes, preferring the live selection and falling back to the screen itself", () => {
    const state = withError(withSelection(withRoute(emptyCapture(), "/products"), "CAF-GRA-500", "/products"), "boom");
    expect(captured(state, { pathname: "/support", selection: "" })).toEqual({ route: "/products", selection: "CAF-GRA-500", lastAuditIds: [], consoleErrors: ["boom"] });
    // On the support screen a selection belongs to the ticket form, not to the screen the ticket is about.
    expect(captured(state, { pathname: "/support", selection: "texto del formulario" }).selection).toBe("CAF-GRA-500");
    expect(captured(state, { pathname: "/products", selection: "otra cosa" })).toMatchObject({ route: "/products", selection: "otra cosa" });
    expect(captured(emptyCapture(), { pathname: "/support", selection: "" }).route).toBe("/support");
    expect(captured(emptyCapture(), { pathname: "/categories", selection: "" }).route).toBe("/categories");
  });
});
