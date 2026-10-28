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
    expect(parseShellPref({ key: "home_layout", value: {}, savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "pink", savedAt: now }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "dark" }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "dark", savedAt: -1 }, now)).toBeNull();
    expect(parseShellPref({ key: "theme", value: "dark", savedAt: now + 2 * 86_400_000 }, now)).toBeNull();
    expect(parseShellPref(null, now)).toBeNull();
    expect(parseShellPref("theme", now)).toBeNull();
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
