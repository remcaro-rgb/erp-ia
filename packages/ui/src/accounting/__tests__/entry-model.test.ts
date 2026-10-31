import { describe, expect, it } from "vitest";
import { allowedActions, entryDraftOf, entryInput, lineTotals, nextFocus, visibleColumns, type EditorLine, type EntrySettings } from "../entry-model";

const settings = (over: Partial<EntrySettings> = {}): EntrySettings => ({ requireApprovalOnManual: false, useOpenAuxiliaries: false, useItems: false, useBusinessUnits: false, ...over });
const pick = (id: string, label = id) => ({ id, label });
const line = (over: Partial<EditorLine> = {}): EditorLine => ({
  key: "k", account: null, party: null, costCenter: null, openAuxiliary: null, item: null, businessUnit: null, description: "", debit: null, credit: null, restricted: false, ...over,
});

describe("allowedActions", () => {
  const manual = { status: "draft", origin: "manual", createdBy: "andres" } as const;
  const names = (entry: Parameters<typeof allowedActions>[0], s: EntrySettings, userId: string) => allowedActions(entry, s, userId).map((a) => a.action);

  it("draft+fourEyes → submit, void; pending → approve (not for creator), return; posted → reverse; auto entries never submit", () => {
    const fourEyes = settings({ requireApprovalOnManual: true });
    expect(names(manual, fourEyes, "andres")).toEqual(["submit", "void"]);
    // Without the approval flow a draft is posted directly.
    expect(names(manual, settings(), "andres")).toEqual(["post", "void"]);

    const pending = { ...manual, status: "pending" } as const;
    expect(names(pending, fourEyes, "laura")).toEqual(["approve", "return", "void"]);
    const own = allowedActions(pending, fourEyes, "andres");
    expect(own.find((a) => a.action === "approve")).toMatchObject({ disabled: true, hint: "accounting.entry.same_user" });
    expect(allowedActions(pending, fourEyes, "laura").find((a) => a.action === "approve")?.disabled).toBeFalsy();

    expect(names({ ...manual, status: "posted" }, fourEyes, "andres")).toEqual(["reverse"]);
    // A reversal, a closing entry, a reversed or a voided entry have nothing to reverse.
    expect(names({ ...manual, status: "posted", reversalOfId: "x" }, fourEyes, "andres")).toEqual([]);
    expect(names({ ...manual, status: "posted", isClosing: true }, fourEyes, "andres")).toEqual([]);
    expect(names({ ...manual, status: "reversed" }, fourEyes, "andres")).toEqual([]);
    expect(names({ ...manual, status: "voided" }, fourEyes, "andres")).toEqual([]);

    // The engine's entries are controlled by their rule: never sent to approval, even with the flow on.
    expect(names({ ...manual, origin: "auto" }, fourEyes, "andres")).toEqual(["post", "void"]);
  });
});

describe("allowedActions · return needs canReturn", () => {
  const pending = { status: "pending", origin: "manual", createdBy: "andres" } as const;
  const fourEyes = settings({ requireApprovalOnManual: true });
  it("offers Devolver only when the caller may run it", () => {
    expect(allowedActions(pending, fourEyes, "laura", { canReturn: false }).map((a) => a.action)).toEqual(["approve", "void"]);
    expect(allowedActions(pending, fourEyes, "laura", { canReturn: true }).map((a) => a.action)).toEqual(["approve", "return", "void"]);
  });
});

describe("lineTotals", () => {
  it("adds both sides to four decimals and reports the difference; a restricted line makes the sum partial", () => {
    const lines = [line({ debit: 0.1 }), line({ debit: 0.2 }), line({ credit: 0.3 })];
    expect(lineTotals(lines)).toEqual({ debit: 0.3, credit: 0.3, difference: 0, partial: false });
    expect(lineTotals([line({ debit: 100 }), line({ credit: 40 })])).toMatchObject({ difference: 60 });
    expect(lineTotals([line({ debit: 100 }), line({ restricted: true })]).partial).toBe(true);
  });
});

describe("visibleColumns", () => {
  it("shows the dimension columns only while their setting is on", () => {
    expect(visibleColumns(settings())).toEqual(["account", "party", "costCenter", "debit", "credit"]);
    expect(visibleColumns(settings({ useOpenAuxiliaries: true, useItems: true, useBusinessUnits: true }))).toEqual([
      "account", "party", "costCenter", "openAuxiliary", "item", "businessUnit", "debit", "credit",
    ]);
  });
});

describe("nextFocus", () => {
  const columns = visibleColumns(settings());
  it("Tab walks the columns then the next row; Shift+Tab goes back; the end of the last row adds a line only when that row has something", () => {
    expect(nextFocus({ columns, rows: 2, row: 0, col: 0, key: "Tab", shift: false, rowFilled: false })).toEqual({ row: 0, col: 1, addLine: false });
    expect(nextFocus({ columns, rows: 2, row: 0, col: 4, key: "Tab", shift: false, rowFilled: true })).toEqual({ row: 1, col: 0, addLine: false });
    expect(nextFocus({ columns, rows: 2, row: 1, col: 0, key: "Tab", shift: true, rowFilled: false })).toEqual({ row: 0, col: 4, addLine: false });
    expect(nextFocus({ columns, rows: 2, row: 0, col: 0, key: "Tab", shift: true, rowFilled: false })).toBeNull();
    expect(nextFocus({ columns, rows: 1, row: 0, col: 4, key: "Tab", shift: false, rowFilled: true })).toEqual({ row: 1, col: 0, addLine: true });
    expect(nextFocus({ columns, rows: 1, row: 0, col: 4, key: "Tab", shift: false, rowFilled: false })).toBeNull();
  });
  it("Enter on the last cell always adds a line; elsewhere it moves on like Tab", () => {
    expect(nextFocus({ columns, rows: 1, row: 0, col: 4, key: "Enter", shift: false, rowFilled: false })).toEqual({ row: 1, col: 0, addLine: true });
    expect(nextFocus({ columns, rows: 1, row: 0, col: 1, key: "Enter", shift: false, rowFilled: false })).toEqual({ row: 0, col: 2, addLine: false });
  });
});

describe("the form's data", () => {
  it("turns the editor's lines into the process input, leaving out empty rows, and reads a consult row back", () => {
    const lines = [
      line({ account: pick("a1", "110505 · Caja"), debit: 1000, description: "Venta" }),
      line({ account: pick("a2"), party: pick("p1"), businessUnit: pick("b1"), credit: 1000 }),
      line({}),
    ];
    const input = entryInput({ journalId: "j1", date: "2026-10-30", description: "Nota", businessUnitId: "", reverseOn: "" }, lines);
    expect(input).toEqual({
      journalId: "j1", date: "2026-10-30", description: "Nota", businessUnitId: null, reverseOn: null,
      lines: [
        { accountId: "a1", partyId: null, costCenterId: null, openAuxiliaryId: null, itemId: null, businessUnitId: null, description: "Venta", debit: 1000, credit: 0 },
        { accountId: "a2", partyId: "p1", costCenterId: null, openAuxiliaryId: null, itemId: null, businessUnitId: "b1", description: null, debit: 0, credit: 1000 },
      ],
    });

    const draft = entryDraftOf({
      id: "e1", journal_id: "j1", date: "2026-10-30", description: "Nota", business_unit_id: null, reverse_on: null,
      lines: [{ id: "l1", account_id: "a1", account_code: "110505", account_name: "Caja", debit: "1000.0000", credit: "0.0000", is_restricted: false }, { id: "l2", is_restricted: true }],
    });
    expect(draft.header).toMatchObject({ journalId: "j1", date: "2026-10-30", description: "Nota" });
    expect(draft.lines[0]).toMatchObject({ account: { id: "a1", label: "110505 · Caja" }, debit: 1000, credit: null });
    expect(draft.lines[1]).toMatchObject({ restricted: true });
  });
});
