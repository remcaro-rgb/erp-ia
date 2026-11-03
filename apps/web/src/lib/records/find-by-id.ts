"use server";

import { getTranslations } from "next-intl/server";
import { runnableProcesses, withClaims } from "@erp/kernel";
import type { CommandItem } from "@erp/ui";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps } from "@/lib/server/runtime";
import { recordEntities } from "./entities";

// ⌘K by ID (entity types spec, D16): the maestros and documentos whose gap-free `seq` is `id`, read through each entity's masked
// view as the caller (company RLS, record access, field visibility: a hidden ID never matches), for the entities whose consult
// process the caller may run. Each answer opens the record's page.

const IDENT = /^[a-z_][a-z0-9_]*$/;

export async function findRecordsById(id: number): Promise<CommandItem[]> {
  if (!Number.isSafeInteger(id) || id <= 0) return [];
  const caller = await requireCaller();
  const deps = processDeps();
  const typed = recordEntities().flatMap((r) => {
    const def = deps.registry.entities().find((e) => e.id === r.id);
    return def && (def.entityType === "maestro" || def.entityType === "documento") && IDENT.test(def.schema) && IDENT.test(def.table) && IDENT.test(r.titleField) ? [{ r, def }] : [];
  });
  const runnable = await runnableProcesses(deps.sql, deps.registry, caller.claims, typed.map(({ r }) => r.consult));
  const allowed = typed.filter(({ r }) => runnable.has(r.consult));
  if (allowed.length === 0) return [];
  const t = await getTranslations();
  const rows = await withClaims(deps.sql, caller.claims, async (tx) => {
    const out: { entity: string; label: string; id: string; name: string }[] = [];
    for (const { r, def } of allowed) {
      const found = await tx.unsafe<{ id: string; name: unknown }[]>(`select id, ${r.titleField} as name from ${def.schema}.v_${def.table} where seq = $1 limit 5`, [id]);
      const label = t.has(def.label) ? t(def.label) : def.id;
      for (const row of found) out.push({ entity: def.id, label, id: row.id, name: row.name === null || row.name === undefined ? "" : String(row.name) });
    }
    return out;
  });
  return rows.map((row) => ({
    id: `record:${row.entity}:${row.id}`,
    label: t("nav.shell.palette.record_label", { entity: row.label, id: String(id), name: row.name }).replace(/ · $/, ""),
    kind: "record" as const,
    href: `/r/${row.entity}/${row.id}`,
  }));
}
