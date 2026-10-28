import { describe, expect, it } from "vitest";
import { serviceDbUrl } from "../service";

// Final review M5: a production server without DATABASE_URL refuses to start its service connection instead of
// silently reaching for the local Supabase database.
describe("serviceDbUrl", () => {
  it("uses DATABASE_URL when it is set, in any environment", () => {
    expect(serviceDbUrl({ NODE_ENV: "production", DATABASE_URL: "postgresql://db.example/erp" })).toBe("postgresql://db.example/erp");
    expect(serviceDbUrl({ NODE_ENV: "development", DATABASE_URL: "postgresql://db.example/erp" })).toBe("postgresql://db.example/erp");
  });

  it("falls back to the local Supabase database outside production", () => {
    expect(serviceDbUrl({ NODE_ENV: "development" })).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(serviceDbUrl({ NODE_ENV: "test" })).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
    expect(serviceDbUrl({})).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("refuses a missing or empty DATABASE_URL in production with a clear error", () => {
    expect(() => serviceDbUrl({ NODE_ENV: "production" })).toThrow(/DATABASE_URL is required in production/);
    expect(() => serviceDbUrl({ NODE_ENV: "production", DATABASE_URL: "" })).toThrow(/DATABASE_URL is required in production/);
  });
});
