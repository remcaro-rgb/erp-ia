import { expect, test as base, type Page } from "@playwright/test";

// `next dev` streams a page's Suspense boundaries into hidden `<div id="S:n">` staging blocks and moves each into
// place when its `$RC` script runs. Hydration can finish first, so for a moment right after a full page load the
// page holds two copies of a screen (the client's in the shell and the server's, hidden, at the end of <body>): a
// `getByLabel`, `getByTestId` or CSS locator then matches twice and fails in strict mode. `next start` does not show
// it (0 in 40 loads against 2 in 25 on the dev server). The specs wait for the staging blocks to be gone after each
// full load, so a locator sees one copy.
const STAGING = 'div[hidden][id^="S:"]';

async function streamed(page: Page): Promise<void> {
  await page.waitForFunction((selector) => !document.querySelector(selector), STAGING, { timeout: 10_000 }).catch(() => {});
}

function waitForStreamed(page: Page): Page {
  const goto = page.goto.bind(page);
  const reload = page.reload.bind(page);
  page.goto = async (...args: Parameters<Page["goto"]>) => {
    const response = await goto(...args);
    if (args[1]?.waitUntil !== "commit") await streamed(page);
    return response;
  };
  page.reload = async (...args: Parameters<Page["reload"]>) => {
    const response = await reload(...args);
    if (args[0]?.waitUntil !== "commit") await streamed(page);
    return response;
  };
  return page;
}

/** Playwright's `test` whose pages (the default one and those a test opens in its `context`) wait for the staging blocks. */
export const test = base.extend({
  page: async ({ page }, provide) => {
    await provide(waitForStreamed(page));
  },
  context: async ({ context }, provide) => {
    context.on("page", (page) => void waitForStreamed(page));
    await provide(context);
  },
});

export { expect };
