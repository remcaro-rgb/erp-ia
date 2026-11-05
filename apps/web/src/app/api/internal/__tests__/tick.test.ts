import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/internal/outbox/tick (design §5.5, §21): the machine-to-machine tick that drains the outbox. The Docker
// worker calls it every 30 s with `x-internal-token`; Vercel Cron calls it every minute with GET and its own
// `Authorization: Bearer <CRON_SECRET>`. Without the right secret nothing is drained.

const state = vi.hoisted(() => ({ drained: 0, calls: [] as unknown[][], fail: false }));
const sql = vi.hoisted(() => ({ service: true }));
vi.mock("@erp/kernel/workflows", () => ({
  drainOutbox: vi.fn(async (...args: unknown[]) => {
    state.calls.push(args);
    if (state.fail) throw new Error("database down");
    return state.drained;
  }),
}));
vi.mock("@/lib/server/runtime", () => ({ processDeps: () => ({ sql }) }));

import { GET, POST } from "../outbox/tick/route";

const URL_ = "http://localhost/api/internal/outbox/tick";
const post = (headers: Record<string, string> = {}) => POST(new Request(URL_, { method: "POST", headers }));
const get = (headers: Record<string, string> = {}) => GET(new Request(URL_, { headers }));

beforeEach(() => {
  vi.stubEnv("INTERNAL_TOKEN", "a-long-local-internal-token");
  vi.stubEnv("CRON_SECRET", "the-vercel-cron-secret");
  state.drained = 0;
  state.calls = [];
  state.fail = false;
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/internal/outbox/tick", () => {
  it("401 without the x-internal-token header, and nothing is drained", async () => {
    const response = await post();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ code: "unauthenticated", details: null });
    expect(state.calls).toHaveLength(0);
  });

  it("401 with a wrong token, also one that only shares a prefix or differs in length", async () => {
    for (const token of ["wrong", "a-long-local-internal-toke", "a-long-local-internal-tokenX", ""]) {
      expect((await post({ "x-internal-token": token })).status).toBe(401);
    }
    expect(state.calls).toHaveLength(0);
  });

  it("401 for every caller when INTERNAL_TOKEN is not configured (closed, never open)", async () => {
    vi.stubEnv("INTERNAL_TOKEN", "");
    expect((await post({ "x-internal-token": "" })).status).toBe(401);
    expect((await post({ "x-internal-token": "undefined" })).status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });

  it("with the token: drains the outbox through the service connection and answers how many runs it started", async () => {
    state.drained = 3;
    const response = await post({ "x-internal-token": "a-long-local-internal-token" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dispatched: 3 });
    expect(state.calls).toEqual([[sql, 100]]);
  });

  it("an empty outbox answers { dispatched: 0 }", async () => {
    const response = await post({ "x-internal-token": "a-long-local-internal-token" });
    expect(await response.json()).toEqual({ dispatched: 0 });
  });

  it("a failing drain answers 500 without the error's text", async () => {
    state.fail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post({ "x-internal-token": "a-long-local-internal-token" });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "handler_failed", details: null });
    spy.mockRestore();
  });

  it("the Vercel Cron secret is not accepted as the internal token", async () => {
    expect((await post({ "x-internal-token": "the-vercel-cron-secret" })).status).toBe(401);
  });
});

describe("GET /api/internal/outbox/tick (Vercel Cron)", () => {
  it("drains with Authorization: Bearer <CRON_SECRET>", async () => {
    state.drained = 2;
    const response = await get({ authorization: "Bearer the-vercel-cron-secret" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ dispatched: 2 });
  });

  it("401 without it, with another secret, or when CRON_SECRET is not configured", async () => {
    expect((await get()).status).toBe(401);
    expect((await get({ authorization: "Bearer a-long-local-internal-token" })).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await get({ authorization: "Bearer " })).status).toBe(401);
    expect(state.calls).toHaveLength(0);
  });
});

describe("the proxy", () => {
  it("does not gate /api/internal/* (no user session there; the handler checks its secret), and still gates the rest", async () => {
    const { config } = await import("@/proxy");
    const matches = (path: string) => config.matcher.some((pattern) => new RegExp(`^${pattern}$`).test(path));
    expect(matches("/api/internal/outbox/tick")).toBe(false);
    expect(matches("/api/export")).toBe(true);
    expect(matches("/api/agent/turn/wrun_1/stream")).toBe(true);
    expect(matches("/")).toBe(true);
  });
});
