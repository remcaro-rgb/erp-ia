import { describe, expect, it } from "vitest";
import { parseShellPref, savedFrom } from "./validate";

// What the browser may save as a shell preference (server action and the pagehide beacon share this), and how
// a stored row becomes the `{ value, savedAt }` the shell compares with its cache.

const now = Date.UTC(2026, 9, 28);

describe("parseShellPref", () => {
  it("accepts a theme mode and a tabs state with their save time", () => {
    expect(parseShellPref({ key: "theme", value: "dark", savedAt: now }, now)).toEqual({ key: "theme", stored: { value: "dark", savedAt: now } });
    const tabs = parseShellPref({ key: "tabs", value: { tabs: [{ id: "/parties", title: "Terceros", href: "/parties", kind: "grid" }], activeId: "/parties" }, savedAt: now }, now);
    expect(tabs?.key).toBe("tabs");
    expect((tabs?.stored.value as { tabs: { href: string }[] }).tabs.map((t) => t.href)).toEqual(["/", "/parties"]);
  });

  it("repairs a tabs state instead of storing what the browser sent", () => {
    const tabs = parseShellPref({ key: "tabs", value: { tabs: [{ id: "x", title: "X", href: "https://evil.example", kind: "grid" }], activeId: "x" }, savedAt: now }, now);
    expect(tabs?.stored.value).toMatchObject({ activeId: "home" });
    expect((tabs?.stored.value as { tabs: unknown[] }).tabs).toHaveLength(1);
  });

  it("refuses other keys, bad themes and missing or absurd times", () => {
    expect(parseShellPref({ key: "grid.core_party.columns", value: {}, savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "pink", savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "dark" }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "dark", savedAt: -1 }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "dark", savedAt: now + 2 * 86_400_000 }, now)).toBeNull();
    expect(parseShellPref(null, now)).toBeNull();
    expect(parseShellPref("theme", now)).toBeNull();
  });
});

describe("parseShellPref, the home layout", () => {
  const layout = [{ id: "kpis", w: 4, h: 200 }, { id: "recent", w: 2, h: 360 }];

  it("accepts a layout of known widgets with its save time", () => {
    expect(parseShellPref({ key: "home_layout", value: layout, savedAt: now }, now)).toEqual({ key: "home_layout", stored: { value: layout, savedAt: now } });
  });

  it("stores the repaired layout, never what the browser sent (spans and heights are clamped)", () => {
    const parsed = parseShellPref({ key: "home_layout", value: [{ id: "kpis", w: 9, h: 5, extra: "x" }], savedAt: now }, now);
    expect(parsed?.stored.value).toEqual([{ id: "kpis", w: 4, h: 160 }]);
  });

  it("refuses an unknown widget, a repeated one and something that is not a list", () => {
    expect(parseShellPref({ key: "home_layout", value: [{ id: "ghost", w: 1, h: 200 }], savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "home_layout", value: [layout[0], layout[0]], savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "home_layout", value: {}, savedAt: now }, now)).toBeNull();
  });
});

describe("parseShellPref, the assistant drawer", () => {
  it("accepts a boolean with its save time under the key assistant.open", () => {
    expect(parseShellPref({ key: "assistant.open", value: true, savedAt: now }, now)).toEqual({ key: "assistant.open", stored: { value: true, savedAt: now } });
    expect(parseShellPref({ key: "assistant.open", value: false, savedAt: now }, now)).toEqual({ key: "assistant.open", stored: { value: false, savedAt: now } });
  });

  it("refuses anything that is not a boolean, and absurd times", () => {
    for (const value of ["true", 1, 0, null, undefined, {}, []]) expect(parseShellPref({ key: "assistant.open", value, savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "assistant.open", value: true }, now)).toBeNull();
    expect(parseShellPref({ key: "assistant.open", value: true, savedAt: now + 2 * 86_400_000 }, now)).toBeNull();
  });
});

describe("parseShellPref, the DIAN hints toggle of the record forms", () => {
  it("accepts a boolean with its save time under the key forms.dian_hints", () => {
    expect(parseShellPref({ key: "forms.dian_hints", value: true, savedAt: now }, now)).toEqual({ key: "forms.dian_hints", stored: { value: true, savedAt: now } });
    expect(parseShellPref({ key: "forms.dian_hints", value: false, savedAt: now }, now)).toEqual({ key: "forms.dian_hints", stored: { value: false, savedAt: now } });
  });

  it("refuses anything that is not a boolean, and absurd times", () => {
    for (const value of ["true", 1, 0, null, undefined, {}, []]) expect(parseShellPref({ key: "forms.dian_hints", value, savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "forms.dian_hints", value: true }, now)).toBeNull();
    expect(parseShellPref({ key: "forms.dian_hints", value: true, savedAt: now + 2 * 86_400_000 }, now)).toBeNull();
  });
});

describe("savedFrom", () => {
  it("reads the stored envelope; a bare legacy value takes the row's time", () => {
    const updatedAt = new Date(now);
    expect(savedFrom({ value: { value: "dark", savedAt: 5 }, updatedAt })).toEqual({ value: "dark", savedAt: 5 });
    expect(savedFrom({ value: "light", updatedAt })).toEqual({ value: "light", savedAt: now });
    expect(savedFrom(undefined)).toBeNull();
  });
});
