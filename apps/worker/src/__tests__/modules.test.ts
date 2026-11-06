import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WORKER_MODULES } from "../modules";

// The worker registers the modules the web app ships (plan 2B Task 14): the list in apps/web's runtime and the worker's are the same.
const runtime = readFileSync(fileURLToPath(new URL("../../../web/src/lib/server/runtime.ts", import.meta.url)), "utf8");

describe("worker modules", () => {
  it("are the web runtime's modules, in the same order", () => {
    const list = /loadModules\(registry, \[([^\]]+)\]\)/.exec(runtime)?.[1];
    expect(list).toBeDefined();
    const web = list!.split(",").map((s) => s.trim());
    const ids: Record<string, string> = { kernelModule: "kernel" };
    expect(WORKER_MODULES.map((m) => m.id)).toEqual(web.map((name) => ids[name] ?? name));
  });

  it("include the sales chain: sales, inventory, costing and accounting", () => {
    expect(WORKER_MODULES.map((m) => m.id)).toEqual(expect.arrayContaining(["sales", "inventory", "costing", "accounting"]));
  });
});
