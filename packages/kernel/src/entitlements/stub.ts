import type { Sql } from "postgres";

/** Whether the company may use `key` (`module:x`, `feature:x.y`, `process:x.y.z`, `limit:x`). */
export type EntitledFn = (sql: Sql, companyId: string, key: string) => Promise<boolean>;

/** Stub until Task 6 lands `kernel.entitled`: everything is entitled. */
export const entitled: EntitledFn = async () => true;
