import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // Docker target (design §21): a self-contained `server.js` with only the traced files, run by Dockerfile.web. The
  // monorepo root is the trace root, so the workspace packages (packages/*) are included.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  // The Workflow runtime loads the World named by WORKFLOW_TARGET_WORLD with a runtime require from the app root, so
  // the Postgres World must stay a real package in the standalone node_modules (lib/server/world.ts references it).
  serverExternalPackages: ["@workflow/world-postgres"],
  // `next dev` only (item 205, option A): the e2e runs sign in on 127.0.0.1:3100, which Next 16 treats as a cross-origin dev request.
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

// Locale and messages per request: src/i18n/request.ts.
const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// "use workflow" / "use step" (durable work, rule 6): the import route starts kernel workflows with start().
export default withWorkflow(withNextIntl(nextConfig));
