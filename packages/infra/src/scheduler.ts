// Scheduling (rule 6, design §5.10). Phase 1 has one scheduled job, the outbox tick; the `kernel.scheduled_tasks`
// table and its claim loop arrive in phase 3 behind this same interface. The tick itself is the same on both targets;
// what drives it differs: Vercel Cron calls GET /api/internal/outbox/tick every minute (vercel.json), the Docker
// worker calls POST /api/internal/outbox/tick every 30 s.

export interface TickResult {
  /** Workflow runs started by this tick. */
  dispatched: number;
}

export interface Scheduler {
  /** Who calls `tick` on this target. */
  readonly driver: "vercel-cron" | "worker-loop";
  /** One pass: drains what is due and answers how many runs it started. */
  tick(): Promise<TickResult>;
}

/** A scheduler over `drain` (the kernel's `drainOutbox`, bound to its connection by the caller). */
export function tickScheduler(driver: Scheduler["driver"], drain: () => Promise<number>): Scheduler {
  return {
    driver,
    async tick() {
      return { dispatched: await drain() };
    },
  };
}

/**
 * Runs `task` now and then every `intervalMs`, never two at once (a slow pass delays the next one instead of
 * overlapping it). A failing pass goes to `onError` and the loop goes on. Answers the function that stops it.
 */
export function runEvery(intervalMs: number, task: () => Promise<unknown>, onError: (error: unknown) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pass = async () => {
    try {
      await task();
    } catch (error) {
      onError(error);
    }
    if (!stopped) timer = setTimeout(pass, intervalMs);
  };
  void pass();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
