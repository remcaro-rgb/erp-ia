import { afterEach, describe, expect, it, vi } from "vitest";
import { runEvery } from "../scheduler";

// The Docker worker's tick loop: runs at once, then every interval, never two passes at once, survives a failing pass.

afterEach(() => vi.useRealTimers());

describe("runEvery", () => {
  it("runs at once and then every interval until stopped", async () => {
    vi.useFakeTimers();
    let runs = 0;
    const stop = runEvery(30_000, async () => void runs++, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runs).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toBe(4);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(runs).toBe(4);
  });

  it("a slow pass delays the next one instead of overlapping it", async () => {
    vi.useFakeTimers();
    let running = 0;
    let overlapped = false;
    let runs = 0;
    const stop = runEvery(1_000, async () => {
      running++;
      if (running > 1) overlapped = true;
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      running--;
    }, () => {});
    await vi.advanceTimersByTimeAsync(20_000);
    stop();
    expect(overlapped).toBe(false);
    expect(runs).toBeGreaterThan(1);
    expect(runs).toBeLessThanOrEqual(4);
  });

  it("a failing pass is reported and the loop goes on", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let runs = 0;
    const stop = runEvery(10, async () => {
      runs++;
      if (runs === 1) throw new Error("web not up yet");
    }, (error) => errors.push(error));
    await vi.advanceTimersByTimeAsync(25);
    stop();
    expect(errors).toHaveLength(1);
    expect(runs).toBeGreaterThanOrEqual(2);
  });
});

describe("runEvery backoff", () => {
  it("backs off exponentially on consecutive failures, up to 5 minutes, and resets after a success", async () => {
    vi.useFakeTimers();
    const at: number[] = [];
    let failing = true;
    const start = Date.now();
    const stop = runEvery(30_000, async () => {
      at.push(Date.now() - start);
      if (failing) throw new Error("web down");
    }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    // Failures at 0, then waits of 60 s, 120 s, 240 s, 300 s (capped), 300 s.
    await vi.advanceTimersByTimeAsync(60_000 + 120_000 + 240_000 + 300_000 + 300_000);
    expect(at).toEqual([0, 60_000, 180_000, 420_000, 720_000, 1_020_000]);
    // Back to the plain interval once a pass succeeds.
    failing = false;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(at.at(-1)).toBe(1_320_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(at.at(-1)).toBe(1_350_000);
    stop();
  });
});
