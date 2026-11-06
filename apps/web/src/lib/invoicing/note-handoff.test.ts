import { describe, expect, it } from "vitest";
import { handOffNote, pendingNote, subscribeNotes, takeNote } from "./note-handoff";

describe("note handoff (Duplicar of a note)", () => {
  it("keeps one copy per invoice until its page takes it, and tells the pages", () => {
    let calls = 0;
    const stop = subscribeNotes(() => calls++);
    handOffNote("inv-1", { kind: "credit", concept: "1", reason: "x", lines: [] });
    expect(pendingNote("inv-1")?.concept).toBe("1");
    expect(pendingNote("inv-2")).toBeNull();
    expect(takeNote("inv-1")?.reason).toBe("x");
    expect(takeNote("inv-1")).toBeNull();
    expect(calls).toBe(2);
    stop();
  });
});
