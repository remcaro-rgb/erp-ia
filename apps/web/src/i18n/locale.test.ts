import { describe, expect, it } from "vitest";
import { resolveLocale } from "./locale";

describe("resolveLocale", () => {
  it("takes the locale the proxy verified from the user's claim", () => {
    expect(resolveLocale({ header: "en", cookie: "es-419" })).toBe("en");
    expect(resolveLocale({ header: "es-419", cookie: "en" })).toBe("es-419");
  });

  it("maps regional variants of a supported language to its catalogue", () => {
    expect(resolveLocale({ header: "en-US" })).toBe("en");
    expect(resolveLocale({ header: "es-CO" })).toBe("es-419");
    expect(resolveLocale({ header: "es" })).toBe("es-419");
  });

  it("falls back to the explicit cookie when there is no verified claim", () => {
    expect(resolveLocale({ header: null, cookie: "en" })).toBe("en");
    expect(resolveLocale({ cookie: "en-GB" })).toBe("en");
  });

  it("defaults to es-419 when nothing usable arrives", () => {
    expect(resolveLocale({})).toBe("es-419");
    expect(resolveLocale({ header: "fr", cookie: "de" })).toBe("es-419");
    expect(resolveLocale({ header: "", cookie: "<script>" })).toBe("es-419");
  });

  it("an unsupported claim falls through to the cookie, not to garbage", () => {
    expect(resolveLocale({ header: "fr", cookie: "en" })).toBe("en");
  });
});
