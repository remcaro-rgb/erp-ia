import { describe, expect, it } from "vitest";
import { newerSaved, readCachedPref, writeCachedPref } from "../prefs-cache";
import { memoryStorage } from "./intl";

// The browser cache of the shell's preferences: each value carries when it was saved and for which company,
// so the shell can keep whichever copy is newer, the server's or this browser's.

describe("preference cache", () => {
  it("a newer cache beats an older server copy, and an older cache loses", () => {
    expect(newerSaved({ value: "server", savedAt: 100 }, { value: "cache", savedAt: 200 })).toEqual({ value: "cache", savedAt: 200 });
    expect(newerSaved({ value: "server", savedAt: 300 }, { value: "cache", savedAt: 200 })).toEqual({ value: "server", savedAt: 300 });
    expect(newerSaved({ value: "server", savedAt: 200 }, { value: "cache", savedAt: 200 })).toEqual({ value: "server", savedAt: 200 });
  });

  it("whichever exists wins when the other is missing", () => {
    expect(newerSaved(null, { value: "cache", savedAt: 1 })).toEqual({ value: "cache", savedAt: 1 });
    expect(newerSaved({ value: "server", savedAt: 1 }, null)).toEqual({ value: "server", savedAt: 1 });
    expect(newerSaved(null, null)).toBeNull();
  });

  it("stores value, time and company; reads only the same company's entry; survives garbage", () => {
    const storage = memoryStorage();
    writeCachedPref(storage, "erp.theme.u1", "c1", { value: "dark", savedAt: 5 });
    expect(readCachedPref(storage, "erp.theme.u1", "c1")).toEqual({ value: "dark", savedAt: 5 });
    expect(readCachedPref(storage, "erp.theme.u1", "c2")).toBeNull();
    storage.setItem("erp.theme.u1", "{not json");
    expect(readCachedPref(storage, "erp.theme.u1", "c1")).toBeNull();
    storage.setItem("erp.theme.u1", JSON.stringify({ value: "dark", companyId: "c1" }));
    expect(readCachedPref(storage, "erp.theme.u1", "c1")).toBeNull();
    expect(readCachedPref(null, "erp.theme.u1", "c1")).toBeNull();
  });
});
