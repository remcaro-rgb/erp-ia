import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/kernel/vitest.config.ts",
  "packages/agent/vitest.config.ts",
  "packages/ui/vitest.config.ts",
  "packages/i18n/vitest.config.ts",
  "packages/infra/vitest.config.ts",
  "packages/modules/core/vitest.config.ts",
  "packages/modules/accounting/vitest.config.ts",
  "packages/modules/costing/vitest.config.ts",
  "packages/modules/crm/vitest.config.ts",
  "packages/modules/inventory/vitest.config.ts",
  "packages/modules/invoicing/vitest.config.ts",
  "packages/modules/payments/vitest.config.ts",
  "packages/modules/sales/vitest.config.ts",
  "packages/modules/support/vitest.config.ts",
  "packages/modules/warehouse/vitest.config.ts",
  "packages/localization/co/vitest.config.ts",
  "apps/web/vitest.config.ts",
  "apps/worker/vitest.config.ts",
  "scripts/vitest.config.ts",
]);
