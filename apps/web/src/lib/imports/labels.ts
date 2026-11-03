import "server-only";
import { getTranslations } from "next-intl/server";
import { importColumns, type Registry } from "@erp/kernel";
import { importLines, LINES_LABEL_PREFIX, type ImportLabels } from "@erp/kernel/import";

/**
 * The header of each import column of `entity` in the user's language (the registry's field labels), so the
 * template carries Spanish headers and a file with those headers maps back to the columns. A documento's lines sheet (entity types
 * spec §2.5, D14) has its own columns, labelled under `lines.<key>` (a key may be both a header's and a line's). Throws the process
 * refusal for an entity that cannot be imported.
 */
export async function importLabels(registry: Registry, entity: string): Promise<ImportLabels> {
  const t = await getTranslations();
  const label = (c: { key: string; label: string }) => (t.has(c.label) ? t(c.label) : c.key);
  const lines = importLines(registry, entity);
  return {
    ...Object.fromEntries(importColumns(registry, entity).map((c) => [c.key, label(c)])),
    ...Object.fromEntries((lines?.columns ?? []).filter((c) => c.key !== "ref").map((c) => [`${LINES_LABEL_PREFIX}${c.key}`, label(c)])),
  };
}
