import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { messages, type Messages } from "@erp/i18n";
import type { LoginError } from "@/lib/auth/login";

// The sign-in surface reads its copy from the `auth` namespace: every key the components ask for exists in both
// catalogues, and every error the sign-in sequence can answer has its message.

const at = (tree: Messages, path: string): string | undefined => {
  let node: Messages | string | undefined = tree;
  for (const part of path.split(".")) node = typeof node === "object" ? node[part] : undefined;
  return typeof node === "string" ? node : undefined;
};

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : /\.tsx$/.test(name) ? [full] : [];
  });

describe("auth copy", () => {
  const appDir = join(import.meta.dirname, "..", "app");

  it("has a message for every login error code", () => {
    const codes: Record<LoginError, true> = {
      invalid_credentials: true,
      no_company: true,
      invalid_code: true,
      no_session: true,
      no_factor: true,
      mfa_required: true,
      too_many_attempts: true,
      unavailable: true,
    };
    for (const code of Object.keys(codes)) {
      expect(at(messages("es-419"), `auth.errors.${code}`), `es-419 auth.errors.${code}`).toBeTruthy();
      expect(at(messages("en"), `auth.errors.${code}`), `en auth.errors.${code}`).toBeTruthy();
    }
  });

  it("defines every auth key the pages and components use", () => {
    const used = sources(appDir)
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bt\(\s*"([a-z0-9_.]+)"/g)].map((m) => m[1]!))
      .sort();
    expect(used.length).toBeGreaterThan(15);
    for (const locale of ["es-419", "en"] as const) {
      expect(used.filter((key) => at(messages(locale), `auth.${key}`) === undefined), locale).toEqual([]);
    }
  });
});
