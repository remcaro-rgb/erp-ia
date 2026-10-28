import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/kernel/vitest.config.ts",
  "packages/agent/vitest.config.ts",
  "packages/ui/vitest.config.ts",
  "packages/i18n/vitest.config.ts",
  "packages/infra/vitest.config.ts",
  "packages/modules/core/vitest.config.ts",
  "packages/modules/support/vitest.config.ts",
  "packages/localization/co/vitest.config.ts",
  "apps/web/vitest.config.ts",
  "scripts/vitest.config.ts",
]);
