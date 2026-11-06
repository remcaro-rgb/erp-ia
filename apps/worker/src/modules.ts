import { kernelModule, type ModuleDef } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { inventory } from "@erp/module-inventory";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";

/**
 * The modules the worker loads and registers: exactly the ones the web app ships (apps/web/src/lib/server/runtime.ts), in the same order,
 * so the registry the worker syncs at start names every module whose events the outbox carries (the sales chain of plan 2B Task 14:
 * sales → inventory → costing → accounting, and sales → invoicing → accounting / sales, Task 16). modules.test.ts keeps the two lists equal.
 */
export const WORKER_MODULES: ModuleDef[] = [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments];
