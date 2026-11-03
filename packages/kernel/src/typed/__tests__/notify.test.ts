import { afterEach, describe, expect, it, vi } from "vitest";
import { recordNotify, recordNotifyOutcome } from "../notify";

// n5 (Task 12 fix round 2): Notificar's outcome is written after its mail went out; a failed write is retried and logged, never lost
// silently, and never thrown at the caller (the send's outcome is the answer).
describe("recordNotifyOutcome", () => {
  afterEach(() => vi.restoreAllMocks());
  const outcome = { status: "sent" as const, providerId: "p-1", error: null };

  it("retries a failed write until it lands, logging each failure", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const asCaller = (async () => {
      calls++;
      if (calls < 3) throw new Error("connection reset");
    }) as never;
    expect(await recordNotifyOutcome(asCaller, "log-1", outcome, { waitMs: 1 })).toBe(true);
    expect(calls).toBe(3);
    expect(errors).toHaveBeenCalledTimes(2);
    expect(String(errors.mock.calls[0]![0])).toContain("log-1");
  });

  it("gives up after the attempts without throwing and logs that the row stays queued with the real outcome", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const asCaller = (async () => {
      throw new Error("database down");
    }) as never;
    expect(await recordNotifyOutcome(asCaller, "log-2", outcome, { attempts: 2, waitMs: 1 })).toBe(false);
    expect(errors).toHaveBeenCalledTimes(3);
    expect(String(errors.mock.calls.at(-1)![0])).toMatch(/log-2 stays queued although the mail was sent/);
  });
});

// Minor 3 (final review): Notificar outside a top-level runProcess run (a context without afterCommit) could never send its mail.
describe("recordNotify outside a top-level run", () => {
  it("is refused before anything is read, logged or sent", async () => {
    const tx = vi.fn();
    const ctx = { tx, registry: { entity: vi.fn() }, locale: "es-419", companyId: "c" } as never;
    await expect(recordNotify.handler(ctx, { entity: "x.y", recordId: "00000000-0000-7000-8000-000000000000", to: ["a@b.co"] } as never)).rejects.toMatchObject({ code: "handler_failed" });
    expect(tx).not.toHaveBeenCalled();
  });
});
