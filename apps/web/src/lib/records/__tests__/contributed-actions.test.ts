import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessError } from "@erp/kernel";

const calls = vi.hoisted(() => ({ runProcess: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ created: true })) }));
const tab = vi.hoisted(() => ({ id: "w.picks", label: "tab.picks", forEntities: ["sales.order"], kind: "grid", feature: "w.f", source: "w.pick", recordField: "order_id", action: { label: "tab.create_pick", process: "w.pick.create", inputField: "orderId" } }));
const deps = vi.hoisted(() => ({ registry: { recordTabsFor: (entity: string) => (entity === "sales.order" ? [tab] : []) } }));
vi.mock("@erp/kernel", async (original) => ({ ...(await original<typeof import("@erp/kernel")>()), runProcess: calls.runProcess }));
vi.mock("@/lib/auth/claims", () => ({ requireCaller: async () => ({ claims: { sub: "u-1", active_company_id: "c1" }, origin: "ui" }) }));
vi.mock("@/lib/auth/disabled", () => ({ signOutIfDisabled: async () => {} }));
vi.mock("@/lib/server/runtime", () => ({ processDeps: () => deps }));

import { runContributedAction } from "../contributed-actions";

// The button of a contributed grid tab (plan 2B.2 Task 29.4, RG-9, owner item 239): the manifest's process, run as the session's user;
// a sensitive one (rule 15) answers step_up_required and runs again with the token the screen obtained.

const ORDER = "0197a1b2-0000-7000-8000-0000000000aa";
const caller = (stepUpToken?: string) => ({ claims: { sub: "u-1", active_company_id: "c1" }, origin: "ui", ...(stepUpToken ? { stepUpToken } : {}) });

beforeEach(() => {
  calls.runProcess.mockReset();
  calls.runProcess.mockImplementation(async () => ({ created: true }));
});

describe("runContributedAction", () => {
  it("runs the tab's process with the record id as its input field", async () => {
    expect(await runContributedAction("sales.order", "w.picks", ORDER)).toEqual({ ok: true, reason: null });
    expect(calls.runProcess).toHaveBeenCalledWith(deps, caller(), "w.pick.create", { orderId: ORDER });
  });

  it("a sensitive process answers step_up_required, and the run with the step-up token carries it to runProcess", async () => {
    calls.runProcess.mockRejectedValueOnce(new ProcessError("step_up_required", "verify"));
    expect(await runContributedAction("sales.order", "w.picks", ORDER)).toEqual({ ok: false, code: "step_up_required", messages: [] });
    expect(await runContributedAction("sales.order", "w.picks", ORDER, "tok-1")).toEqual({ ok: true, reason: null });
    expect(calls.runProcess).toHaveBeenLastCalledWith(deps, caller("tok-1"), "w.pick.create", { orderId: ORDER });
  });

  it("a run that made nothing answers the process's reason", async () => {
    calls.runProcess.mockResolvedValueOnce({ created: false, reason: "open_pick" });
    expect(await runContributedAction("sales.order", "w.picks", ORDER)).toEqual({ ok: true, reason: "open_pick" });
  });
});
