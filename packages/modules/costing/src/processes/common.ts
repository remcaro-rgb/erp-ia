import { ProcessError } from "@erp/kernel";

/**
 * A refusal whose message leads with its code, the accounting convention (the engine and the consumers read the code from it): the
 * first detail follows the code, `details` lists every one.
 */
export function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

/**
 * The company's costing run lock: movement.cost, landed costs and their voids serialize on it, because all of them write the cost layers
 * and the cost events in the order they were committed (same key as movement.cost's feed lock).
 */
export const feedLockKey = (companyId: string): string => `costing.feed:${companyId}`;
