import { describe, expect, it } from "vitest";
import { suggestedAction } from "../recommendations";

// What a stored suggested action may be: a registered-looking process with its input, or an internal path.

describe("suggestedAction", () => {
  it("accepts a process action and an internal link", () => {
    expect(suggestedAction.safeParse({ label: "Crear", processId: "core.party.create", input: { a: 1 } }).success).toBe(true);
    expect(suggestedAction.safeParse({ label: "Ver", href: "/parties?x=1" }).success).toBe(true);
  });

  it("refuses links that leave the app: protocol-relative, absolute, with spaces or backslashes", () => {
    for (const href of ["//evil.example", "https://evil.example", "/ok path", "/\\evil.example", "/a\\b", "evil"]) {
      expect(suggestedAction.safeParse({ label: "Ir", href }).success, href).toBe(false);
    }
  });
});
