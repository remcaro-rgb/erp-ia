import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fixtureRateFeed, httpRateFeed, rateFeedFromEnv } from "../rate-feed";

// The RateFeed port (plan 2B.2 Task 34.1, FX §2, rule 6): the HTTP implementation (plain fetch, valid on cloud and Docker) and the
// fixture implementation tests and CI use (RATE_FEED=fixture), which reads <dir>/<sha1(url)>.json and never calls the internet.

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

describe("fixtureRateFeed", () => {
  it("answers the JSON stored under the sha1 of the URL, and throws when there is none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rate-feed-"));
    writeFileSync(join(dir, `${sha1("https://example.test/a")}.json`), JSON.stringify([{ valor: "1" }]));
    const feed = fixtureRateFeed(dir);
    expect(await feed.getJson("https://example.test/a")).toEqual([{ valor: "1" }]);
    await expect(feed.getJson("https://example.test/b")).rejects.toThrow(/fixture/);
  });
});

describe("httpRateFeed", () => {
  it("fetches with a 10 s timeout and throws on a non-2xx answer", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify([1]), { status: 200 });
    });
    expect(await httpRateFeed(fetchImpl as unknown as typeof fetch).getJson("https://example.test/a")).toEqual([1]);
    const failing = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(httpRateFeed(failing as unknown as typeof fetch).getJson("https://example.test/a")).rejects.toThrow(/503/);
  });
});

describe("rateFeedFromEnv", () => {
  it("RATE_FEED=fixture (and unset) reads the fixture directory; RATE_FEED=http fetches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rate-feed-"));
    writeFileSync(join(dir, `${sha1("https://example.test/a")}.json`), "[2]");
    expect(await rateFeedFromEnv({ RATE_FEED: "fixture", RATE_FEED_DIR: dir }).getJson("https://example.test/a")).toEqual([2]);
    expect(await rateFeedFromEnv({ RATE_FEED_DIR: dir }).getJson("https://example.test/a")).toEqual([2]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("[3]", { status: 200 }));
    try {
      expect(await rateFeedFromEnv({ RATE_FEED: "http", RATE_FEED_DIR: dir }).getJson("https://example.test/a")).toEqual([3]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(() => rateFeedFromEnv({ RATE_FEED: "ftp" })).toThrow(/RATE_FEED/);
  });
});
