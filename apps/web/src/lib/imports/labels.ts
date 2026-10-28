import "server-only";
import { getTranslations } from "next-intl/server";
import { importColumns, type Registry } from "@erp/kernel";
import type { ImportLabels } from "@erp/kernel/import";

/**
 * The header of each import column of `entity` in the user's language (the registry's field labels), so the
 * template carries Spanish headers and a file with those headers maps back to the columns. Throws the process
 * refusal for an entity that cannot be imported.
 */
export async function importLabels(registry: Registry, entity: string): Promise<ImportLabels> {
  const t = await getTranslations();
  return Object.fromEntries(importColumns(registry, entity).map((c) => [c.key, t.has(c.label) ? t(c.label) : c.key]));
}
