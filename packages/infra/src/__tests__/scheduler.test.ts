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
