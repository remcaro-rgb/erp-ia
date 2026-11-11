import "server-only";
import { runGridQuery, withClaims, type Caller } from "@erp/kernel";
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

/** The members of the company by name (the «Vendedor» column of the pedidos' grid reads and filters by them), as the caller's masked users view shows them. */
export async function memberOptions(caller: Caller): Promise<{ value: string; label: string }[]> {
  const deps = processDeps();
  const rows = await withClaims(deps.sql, caller.claims, (tx) => tx<{ id: string; name: string | null }[]>`select id, coalesce(full_name, email) as name from kernel.v_users order by 2`);
  return rows.filter((r) => r.name).map((r) => ({ value: r.id, label: r.name! }));
}
