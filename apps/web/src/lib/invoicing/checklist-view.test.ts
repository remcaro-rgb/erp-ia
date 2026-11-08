import { describe, expect, it } from "vitest";
import { checklistView, type ChecklistConsult } from "./checklist-view";

// The DIAN checklist screen's view model (plan 2B Task 35, R35-11): the consult's rows grouped in the pack's order, the text of the caller's
// locale, the progress, the new items (R35-8) and the effective confirmation.

const item = (key: string, group: string, extra: Partial<ChecklistConsult["items"][number]> = {}): ChecklistConsult["items"][number] => ({
  key, group, es: `texto ${key}`, en: `text ${key}`, docUrl: null, ticked: false, tickedBy: null, tickedAt: null, isNew: false, ...extra,
});
const consult = (items: ChecklistConsult["items"], extra: Partial<ChecklistConsult> = {}): ChecklistConsult => ({
  version: 2, storedVersion: null, confirmed: false, confirmedAt: null, confirmedBy: null, environment: "habilitacion",
  progress: { done: items.filter((i) => i.ticked).length, total: items.length }, items, ...extra,
});

describe("checklistView", () => {
  it("groups the items in the order they come, each group in its place, with the text of the locale", () => {
    const view = checklistView(consult([item("a", "notes_documents"), item("b", "notes_documents"), item("c", "signing_software")]), "es-419");
    expect(view.groups.map((g) => [g.group, g.items.map((i) => i.text)])).toEqual([
      ["notes_documents", ["texto a", "texto b"]],
      ["signing_software", ["texto c"]],
    ]);
    expect(checklistView(consult([item("a", "notes_documents")]), "en").groups[0]!.items[0]!.text).toBe("text a");
    // Any other locale reads Spanish (the default).
    expect(checklistView(consult([item("a", "notes_documents")]), "fr").groups[0]!.items[0]!.text).toBe("texto a");
  });

  it("carries the progress, the pending count, the new items and whether the confirmation can be asked for", () => {
    const items = [item("a", "g", { ticked: true, tickedBy: "Ana", tickedAt: "2026-11-07T10:00:00.000Z" }), item("b", "g", { isNew: true }), item("c", "g", { ticked: true })];
    const view = checklistView(consult(items, { storedVersion: 1, confirmed: false, progress: { done: 2, total: 3 } }), "es-419");
    expect(view.progress).toEqual({ done: 2, total: 3 });
    expect(view.newItems.map((i) => i.key)).toEqual(["b"]);
    expect(view.canConfirm).toBe(false);
    expect(view.groups[0]!.items[0]).toMatchObject({ key: "a", ticked: true, tickedBy: "Ana", tickedAt: "2026-11-07T10:00:00.000Z" });
    const all = checklistView(consult([item("a", "g", { ticked: true })], { progress: { done: 1, total: 1 } }), "es-419");
    expect(all.canConfirm).toBe(true);
  });

  it("an effective confirmation cannot be asked for again, and shows who and when", () => {
    const view = checklistView(consult([item("a", "g", { ticked: true })], { storedVersion: 2, confirmed: true, confirmedAt: "2026-11-07T11:00:00.000Z", confirmedBy: "Ana", progress: { done: 1, total: 1 } }), "es-419");
    expect(view.confirmed).toBe(true);
    expect(view.canConfirm).toBe(false);
    expect(view.confirmedAt).toBe("2026-11-07T11:00:00.000Z");
    expect(view.confirmedBy).toBe("Ana");
  });

  it("in producción nothing can be unticked, and a confirmation is asked again only when the new items are ticked", () => {
    const view = checklistView(consult([item("a", "g", { ticked: true }), item("b", "g", { isNew: true })], { storedVersion: 1, environment: "produccion", progress: { done: 1, total: 2 } }), "es-419");
    expect(view.locksUnticking).toBe(true);
    expect(view.newItems).toHaveLength(1);
    expect(checklistView(consult([item("a", "g")], { environment: "habilitacion" }), "es-419").locksUnticking).toBe(false);
    const ready = checklistView(consult([item("a", "g", { ticked: true }), item("b", "g", { ticked: true, isNew: true })], { storedVersion: 1, environment: "produccion", confirmed: false, progress: { done: 2, total: 2 } }), "es-419");
    expect(ready.canConfirm).toBe(true);
  });
});
