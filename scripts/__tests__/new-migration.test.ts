import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMigration } from "../new-migration";

let root: string;
const dir = () => join(root, "supabase", "migrations");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "new-migration-"));
  mkdirSync(dir(), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("new-migration", () => {
  it("starts at 0001 in an empty directory", () => {
    const path = createMigration(root, "kernel", "tenancy");
    expect(path).toBe("supabase/migrations/0001_kernel_tenancy.sql");
    expect(existsSync(join(root, path))).toBe(true);
    expect(readFileSync(join(root, path), "utf8")).toMatch(/^-- 0001_kernel_tenancy/);
  });

  it("picks the next number after the highest existing one", () => {
    writeFileSync(join(dir(), ".keep"), "");
    writeFileSync(join(dir(), "0001_kernel_tenancy.sql"), "");
    writeFileSync(join(dir(), "0007_core_master_data.sql"), "");
    expect(createMigration(root, "support", "tickets")).toBe("supabase/migrations/0008_support_tickets.sql");
  });

  it("rejects names that break rule 34 and writes nothing", () => {
    expect(() => createMigration(root, "Kernel", "tenancy")).toThrow(/migration name/);
    expect(() => createMigration(root, "kernel", "bad-topic")).toThrow(/migration name/);
    expect(() => createMigration(root, "kernel", "")).toThrow(/migration name/);
    expect(() => createMigration(root, "ker_nel", "x")).toThrow(/migration name/);
    expect(readdirSync(dir())).toEqual([]);
  });
});
