import { describe, expect, it } from "vitest";
import { createTabsStore } from "@erp/ui";
import { openCreatedRecord } from "./open-created";

// Task 17 round 1: after a «Crear …» tab saves, the new record's tab must become the active one before the «new» tab closes;
// closing the active «new» tab first made the store activate its neighbour, and the shell navigated there (record.spec Duplicar).

describe("openCreatedRecord", () => {
  it("activates the created record's tab, closes the «new» tab, and navigates to the record", () => {
    const store = createTabsStore();
    store.getState().open({ title: "Auditoría", href: "/admin/users/x", kind: "admin" });
    store.getState().open({ title: "Crear tercero", href: "/r/core.party/new", kind: "record" });
    const navigated: string[] = [];
    const activeAtReplace: string[] = [];
    openCreatedRecord(
      { open: store.getState().open, close: store.getState().close, replace: (href) => { navigated.push(href); activeAtReplace.push(store.getState().activeId); } },
      "core.party",
      "abc",
      "Tercero",
    );
    const { tabs, activeId } = store.getState();
    expect(tabs.map((t) => t.href)).not.toContain("/r/core.party/new");
    expect(activeId).toBe("/r/core.party/abc");
    expect(activeAtReplace).toEqual(["/r/core.party/abc"]);
    expect(navigated).toEqual(["/r/core.party/abc"]);
  });
});
