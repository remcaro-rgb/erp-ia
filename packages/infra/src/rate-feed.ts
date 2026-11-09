import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Env } from "./target";

// The RateFeed port (plan 2B.2 Task 34.1, FX §2; rule 6): how a country pack reads its official exchange-rate source. One HTTP
// implementation (plain fetch, valid on cloud and on Docker/on-premise) and one fixture implementation that tests and CI use, so they never
// call the internet. Chosen by RATE_FEED: `http` fetches; `fixture` (and unset, the safe default, as EINVOICE_TRANSPORT defaults to the
// mock) reads `<RATE_FEED_DIR>/<sha1(url)>.json`. A deployment that imports the real TRM sets RATE_FEED=http.

export interface RateFeed {
  /** The JSON the source answers for `url`; throws when the source cannot answer (network, status, missing fixture). */
  getJson(url: string): Promise<unknown>;
}

/** How long the HTTP feed waits for an answer. */
export const RATE_FEED_TIMEOUT_MS = 10_000;

/** The fixture file name of a URL: the hex sha1 of the URL and `.json`. */
export const rateFeedFixtureName = (url: string): string => `${createHash("sha1").update(url).digest("hex")}.json`;

/** Plain fetch with a 10 s timeout; a non-2xx answer throws. `fetchImpl` is read at call time (default: the global fetch). */
export function httpRateFeed(fetchImpl?: typeof fetch): RateFeed {
  return {
    async getJson(url) {
      const response = await (fetchImpl ?? globalThis.fetch)(url, { signal: AbortSignal.timeout(RATE_FEED_TIMEOUT_MS), headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`rate feed: ${url} answered ${response.status}`);
      return response.json();
    },
  };
}

/** Reads `<dir>/<sha1(url)>.json`; a URL without its file throws, as an unreachable source does. */
export function fixtureRateFeed(dir: string): RateFeed {
  return {
    async getJson(url) {
      const file = join(dir, rateFeedFixtureName(url));
      if (!existsSync(file)) throw new Error(`rate feed: no fixture for ${url} (${file})`);
      return JSON.parse(readFileSync(file, "utf8")) as unknown;
    },
  };
}

/** Where the repository keeps the rate fixtures (the Colombian pack's TRM answers), relative to the repository root. */
const DEFAULT_FIXTURE_DIR = join("packages", "localization", "co", "src", "__fixtures__", "trm");

/** The fixture directory found from the working directory upwards (a package, the web app or the repository root). */
function defaultFixtureDir(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    const candidate = join(dir, DEFAULT_FIXTURE_DIR);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return join(process.cwd(), DEFAULT_FIXTURE_DIR);
    dir = parent;
  }
}

/** The feed RATE_FEED names: `http`, or `fixture` (the default) at RATE_FEED_DIR or the repository's fixtures. */
export function rateFeedFromEnv(env: Env = process.env): RateFeed {
  const mode = env.RATE_FEED ?? "fixture";
  if (mode === "http") return httpRateFeed();
  if (mode === "fixture") return fixtureRateFeed(env.RATE_FEED_DIR ?? defaultFixtureDir());
  throw new Error(`RATE_FEED must be fixture or http, not ${mode}`);
}
