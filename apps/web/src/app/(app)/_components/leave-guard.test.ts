// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { goBackPast } from "./leave-guard";

// Back from a screen with staged changes goes past every entry of that screen: the guard leaves a spent entry of the
// same URL behind, and a reload can make the next guard push a second one (production build).

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

async function stack(paths: string[]) {
  for (const path of paths) {
    window.history.pushState({}, "", path);
    await settle(5);
  }
}

describe("goBackPast", () => {
  it("goes back the given steps when that already leaves the screen", async () => {
    await stack(["/home", "/admin/fields", "/admin/fields"]);
    goBackPast(2);
    await settle();
    expect(window.location.pathname).toBe("/home");
  });

  it("goes on past the entries of the same screen a reload left behind", async () => {
    await stack(["/inicio", "/admin/fields", "/admin/fields", "/admin/fields"]);
    goBackPast(2);
    await settle(150);
    expect(window.location.pathname).toBe("/inicio");
  });

  it("stops after a few extra steps instead of walking the whole history", async () => {
    await stack(["/otra", ...Array.from({ length: 9 }, () => "/admin/fields")]);
    goBackPast(2);
    await settle(300);
    expect(window.location.pathname).toBe("/admin/fields");
  });
});
