import { describe, expect, it } from "vitest";
import { allowedActions, canEditData, isUsable, nextStatus } from "../lifecycle";
import type { LifecycleAction, LifecycleFlags, RecordStatus } from "../lifecycle";

const STATUSES: RecordStatus[] = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];
const ACTIONS: LifecycleAction[] = ["save", "submit", "approve", "reject", "void", "delete", "post"];
const TYPES = ["maestro", "documento"] as const;
const FLAGS: LifecycleFlags[] = [
  { requiresApproval: false, posts: false },
  { requiresApproval: false, posts: true },
  { requiresApproval: true, posts: false },
  { requiresApproval: true, posts: true },
];
const plain = FLAGS[0]!;
const approval = FLAGS[2]!;
const postsOnly = FLAGS[1]!;
const both = FLAGS[3]!;

describe("documento transitions", () => {
  it("draft save -> saved; saved save -> saved", () => {
    expect(nextStatus("documento", "draft", "save", plain)).toBe("saved");
    expect(nextStatus("documento", "saved", "save", plain)).toBe("saved");
  });
  it("submit only with requiresApproval", () => {
    expect(nextStatus("documento", "saved", "submit", plain)).toBeNull();
    expect(nextStatus("documento", "saved", "submit", approval)).toBe("pending");
  });
  it("approve and reject from pending", () => {
    expect(nextStatus("documento", "pending", "approve", approval)).toBe("approved");
    expect(nextStatus("documento", "pending", "reject", approval)).toBe("rejected");
    expect(nextStatus("documento", "saved", "approve", approval)).toBeNull();
  });
  it("rejected save -> saved", () => {
    expect(nextStatus("documento", "rejected", "save", approval)).toBe("saved");
  });
  it("void from saved|pending|rejected|approved; posted void refused (D3)", () => {
    for (const s of ["saved", "pending", "rejected", "approved"] as const) {
      expect(nextStatus("documento", s, "void", both)).toBe("voided");
    }
    expect(nextStatus("documento", "posted", "void", both)).toBeNull();
    expect(nextStatus("documento", "draft", "void", both)).toBeNull();
    expect(nextStatus("documento", "voided", "void", both)).toBeNull();
  });
  it("delete only from draft", () => {
    expect(nextStatus("documento", "draft", "delete", plain)).toBe("deleted");
    for (const s of STATUSES.filter((x) => x !== "draft")) {
      expect(nextStatus("documento", s, "delete", both)).toBeNull();
    }
  });
  it("post from saved (no approval) or approved, only when posts", () => {
    expect(nextStatus("documento", "saved", "post", postsOnly)).toBe("posted");
    expect(nextStatus("documento", "saved", "post", both)).toBeNull();
    expect(nextStatus("documento", "approved", "post", both)).toBe("posted");
    expect(nextStatus("documento", "approved", "post", approval)).toBeNull();
    expect(nextStatus("documento", "saved", "post", plain)).toBeNull();
    expect(nextStatus("documento", "draft", "post", postsOnly)).toBeNull();
  });
  it("posted and voided are terminal", () => {
    for (const s of ["posted", "voided"] as const) {
      for (const a of ACTIONS) expect(nextStatus("documento", s, a, both)).toBeNull();
    }
  });
  it("canEditData only draft/saved/rejected", () => {
    for (const s of STATUSES) {
      expect(canEditData("documento", s)).toBe(s === "draft" || s === "saved" || s === "rejected");
    }
  });
});

describe("maestro transitions", () => {
  it("never posts or voids", () => {
    for (const s of STATUSES) for (const f of FLAGS) {
      expect(nextStatus("maestro", s, "post", f)).toBeNull();
      expect(nextStatus("maestro", s, "void", f)).toBeNull();
    }
  });
  it("posted and voided are not maestro states", () => {
    for (const a of ACTIONS) {
      expect(nextStatus("maestro", "posted", a, both)).toBeNull();
      expect(nextStatus("maestro", "voided", a, both)).toBeNull();
    }
  });
  it("delete allowed from any maestro state", () => {
    for (const s of ["draft", "saved", "pending", "rejected", "approved"] as const) {
      expect(nextStatus("maestro", s, "delete", plain)).toBe("deleted");
    }
  });
  it("approval cycle when requiresApproval", () => {
    expect(nextStatus("maestro", "saved", "submit", approval)).toBe("pending");
    expect(nextStatus("maestro", "saved", "submit", plain)).toBeNull();
    expect(nextStatus("maestro", "pending", "approve", approval)).toBe("approved");
    expect(nextStatus("maestro", "pending", "reject", approval)).toBe("rejected");
    expect(nextStatus("maestro", "rejected", "save", approval)).toBe("saved");
    // D10: an approved maestro whose approval-relevant fields changed goes back to pending
    expect(nextStatus("maestro", "approved", "submit", approval)).toBe("pending");
    expect(nextStatus("maestro", "approved", "save", approval)).toBe("approved");
  });
  it("canEditData always true", () => {
    for (const s of STATUSES) expect(canEditData("maestro", s)).toBe(true);
  });
});

describe("isUsable", () => {
  it("saved usable without approval, not with", () => {
    expect(isUsable("saved", true, { requiresApproval: false })).toBe(true);
    expect(isUsable("saved", true, { requiresApproval: true })).toBe(false);
  });
  it("approved usable only with approval", () => {
    expect(isUsable("approved", true, { requiresApproval: true })).toBe(true);
    expect(isUsable("approved", false, { requiresApproval: true })).toBe(false);
    expect(isUsable("approved", true, { requiresApproval: false })).toBe(false);
  });
  it("inactive never usable; draft never usable", () => {
    expect(isUsable("saved", false, { requiresApproval: false })).toBe(false);
    expect(isUsable("draft", true, { requiresApproval: false })).toBe(false);
  });
});

describe("allowedActions consistency", () => {
  it("every allowed action yields a non-null next status; no others do", () => {
    for (const t of TYPES) for (const s of STATUSES) for (const f of FLAGS) {
      const allowed = allowedActions(t, s, f);
      for (const a of ACTIONS) {
        expect(allowed.includes(a)).toBe(nextStatus(t, s, a, f) !== null);
      }
    }
  });
  it("documento draft offers save and delete", () => {
    expect(allowedActions("documento", "draft", plain)).toEqual(["save", "delete"]);
  });
});
