/**
 * Largest file a record accepts (design §5.13, rule 22): 25 MB. The Storage bucket enforces the same limit.
 * Dependency-free on purpose: the browser panel imports it through `@erp/kernel/limits`.
 */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
