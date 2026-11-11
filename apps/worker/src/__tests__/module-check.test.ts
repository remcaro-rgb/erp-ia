import { describe, expect, it, vi } from "vitest";
import { checkWorkerModules, compareModuleLists, resolveModuleCheckMode } from "../module-check";

// Plan 2B Task 48 (owner item 40, Ruling R48-1): the worker compares its module list with the deployed one before its own sync.
function fakeSql(ids: string[]) {
  const calls: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    calls.push(strings.join("?"));
    return ids.map((module_id) => ({ module_id }));
  }) as never;
  return { sql, calls };
}

describe("compareModuleLists", () => {
  it("names the deployed modules the worker lacks and the extra ones it has", () => {
    expect(compareModuleLists(["a", "b", "x"], ["a", "b", "c"])).toEqual({ missing: ["c"], extra: ["x"] });
    expect(compareModuleLists(["a"], ["a"])).toEqual({ missing: [], extra: [] });
  });
});

describe("checkWorkerModules", () => {
  it("is silent when the lists are equal", async () => {
    const log = vi.fn();
    await checkWorkerModules({ sql: fakeSql(["a", "b"]).sql, workerIds: ["b", "a"], mode: "refuse", log });
    expect(log).not.toHaveBeenCalled();
  });

  it("in warn mode logs once, loudly, naming the missing ids, and resolves", async () => {
    const log = vi.fn();
    await checkWorkerModules({ sql: fakeSql(["a", "sales"]).sql, workerIds: ["a"], mode: "warn", log });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toMatch(/^\[worker\] WARNING module list differs/);
    expect(log.mock.calls[0]![0]).toContain("sales");
  });

  it("in refuse mode rejects with a message naming the ids", async () => {
    await expect(
      checkWorkerModules({ sql: fakeSql(["a", "sales", "crm"]).sql, workerIds: ["a"], mode: "refuse", log: vi.fn() }),
    ).rejects.toThrow(/sales.*crm|crm.*sales/);
  });

  it("in off mode does not query", async () => {
    const f = fakeSql(["a", "sales"]);
    await checkWorkerModules({ sql: f.sql, workerIds: ["a"], mode: "off", log: vi.fn() });
    expect(f.calls).toHaveLength(0);
  });

  it("passes on an empty deployed list (first boot), even in refuse mode", async () => {
    await expect(checkWorkerModules({ sql: fakeSql([]).sql, workerIds: ["a"], mode: "refuse", log: vi.fn() })).resolves.toBeUndefined();
  });

  it("extra worker modules alone never refuse", async () => {
    await expect(checkWorkerModules({ sql: fakeSql(["a"]).sql, workerIds: ["a", "x"], mode: "refuse", log: vi.fn() })).resolves.toBeUndefined();
  });
});

describe("resolveModuleCheckMode", () => {
  it("defaults to refuse in production and warn elsewhere", () => {
    expect(resolveModuleCheckMode({ NODE_ENV: "production" })).toBe("refuse");
    expect(resolveModuleCheckMode({ NODE_ENV: "development" })).toBe("warn");
    expect(resolveModuleCheckMode({})).toBe("warn");
  });
  it("WORKER_MODULE_CHECK overrides; an unknown value is an error", () => {
    expect(resolveModuleCheckMode({ NODE_ENV: "production", WORKER_MODULE_CHECK: "off" })).toBe("off");
    expect(resolveModuleCheckMode({ WORKER_MODULE_CHECK: " Refuse " })).toBe("refuse");
    expect(() => resolveModuleCheckMode({ WORKER_MODULE_CHECK: "nope" })).toThrow(/WORKER_MODULE_CHECK/);
  });
});
