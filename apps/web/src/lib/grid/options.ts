import "server-only";
import { runGridQuery, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";
import { gridDenial, gridEntity } from "./access";

// Option lists the grid shows by label: read as the caller, over the masked view, like any grid.

/** The company's categories as options (id → name), read through the masked view like any grid. */
export async function categoryOptions(caller: Caller): Promise<{ value: string; label: string }[]> {
  const deps = processDeps();
  const categories = gridEntity(deps.registry, "core.product_category");
  if (!categories || (await gridDenial(deps, caller.claims, categories))) return [];
  const { rows } = await runGridQuery(deps.sql, caller.claims, categories, { filters: [], sort: [{ field: "name", dir: "asc" }], page: 1, pageSize: 500, columns: ["name"] });
  return rows.map((r) => ({ value: String(r.id), label: String(r.name ?? r.id) }));
}
