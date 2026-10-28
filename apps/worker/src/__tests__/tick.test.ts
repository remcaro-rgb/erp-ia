import { describe, expect, it, vi } from "vitest";
import { tickOutbox } from "../tick";

// The worker's outbox tick (design §21: "a cron container calling the tick route"): every 30 s it calls the web app's
// POST /api/internal/outbox/tick with the internal token. The drain runs in the web app, where the workflow
// functions are compiled; the worker only drives it.

describe("tickOutbox", () => {
  it("POSTs the tick route with x-internal-token and answers how many runs it started", async () => {
    const fetcher = vi.fn(async () => Response.json({ dispatched: 4 }));
    await expect(tickOutbox({ webUrl: "http://web:3000/", token: "secret-token", fetcher })).resolves.toBe(4);
    expect(fetcher).toHaveBeenCalledWith("http://web:3000/api/internal/outbox/tick", {
      method: "POST",
      headers: { "x-internal-token": "secret-token" },
      signal: expect.any(AbortSignal),
    });
  });

  it("fails with the status when the web app refuses or breaks (the loop logs it and goes on)", async () => {
    const refused = vi.fn(async () => Response.json({ code: "unauthenticated", details: null }, { status: 401 }));
    await expect(tickOutbox({ webUrl: "http://web:3000", token: "wrong", fetcher: refused })).rejects.toThrow(/401/);
    const broken = vi.fn(async () => Response.json({ nothing: true }));
    await expect(tickOutbox({ webUrl: "http://web:3000", token: "t", fetcher: broken })).rejects.toThrow(/dispatched/);
  });
});
