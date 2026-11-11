import "server-only";
import type { Tx } from "@erp/kernel";

// What the order frames read about who owns a pedido (plan 2B Task 39, R39-8, R39-13), always inside the caller's own transaction
// (withClaims), so every read is under the caller's RLS and field visibility (rules 12 and 14): the members' names, the picker of «Cambiar
// vendedor», which pedidos the caller can read at all and each readable pedido's owner (sales.v_order_owners, published for other modules).

export interface Member {
  id: string;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const only = (ids: readonly string[]) => [...new Set(ids.filter((id) => UUID.test(id)))];

/** The members of the caller's company, named as the masked kernel.v_users shows them (name, else e-mail); none for an id it does not show. */
export async function memberNames(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  const wanted = only(ids);
  if (wanted.length === 0) return new Map();
  const rows = await tx<{ id: string; name: string | null }[]>`select id, coalesce(full_name, email) as name from kernel.v_users where id = any(${wanted}::uuid[])`;
  return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name!]));
}

/** The active members a pedido can be handed to (the picker of «Cambiar vendedor»), by name. */
export async function activeMembers(tx: Tx): Promise<Member[]> {
  const rows = await tx<{ id: string; name: string | null }[]>`select id, coalesce(full_name, email) as name from kernel.v_users where coalesce(is_active, true) order by 2`;
  return rows.filter((r) => r.name).map((r) => ({ id: r.id, name: r.name! }));
}

/** Which of these pedidos the caller can read (sales.v_orders under the owner rule): the rest are «Pedido no disponible». */
export async function readableOrderIds(tx: Tx, ids: readonly string[]): Promise<Set<string>> {
  const wanted = only(ids);
  if (wanted.length === 0) return new Set();
  const rows = await tx<{ id: string }[]>`select id from sales.v_orders where id = any(${wanted}::uuid[])`;
  return new Set(rows.map((r) => r.id));
}

/** The owner of each pedido the caller can read (null when it has none or the role does not see the owner). */
export async function orderOwners(tx: Tx, ids: readonly string[]): Promise<Map<string, string | null>> {
  const wanted = only(ids);
  if (wanted.length === 0) return new Map();
  const rows = await tx<{ order_id: string; owner_id: string | null }[]>`select order_id, owner_id from sales.v_order_owners where order_id = any(${wanted}::uuid[])`;
  return new Map(rows.map((r) => [r.order_id, r.owner_id]));
}

/**
 * The pedido ids (`order_id`) and pedido line ids (`order_line_id`, of entrega and factura lines) a record's version snapshots name, header
 * and lines, that the caller cannot read: Versiones shows them as «Pedido no disponible», never as the id (R39-9, final review m1). The
 * lines are read through sales.v_order_lines, which follows its pedido's owner rule. Snapshots are the document's own history; this only
 * hides what the caller may not see.
 */
export async function unreadableOrderIds(tx: Tx, snapshots: readonly { header: Record<string, unknown>; lines: readonly Record<string, unknown>[] }[] | null): Promise<Set<string>> {
  const orders = new Set<string>();
  const lines = new Set<string>();
  for (const s of snapshots ?? []) {
    for (const row of [s.header, ...s.lines]) {
      if (typeof row?.order_id === "string" && UUID.test(row.order_id)) orders.add(row.order_id);
      if (typeof row?.order_line_id === "string" && UUID.test(row.order_line_id)) lines.add(row.order_line_id);
    }
  }
  const hidden = new Set<string>();
  if (orders.size > 0) {
    const readable = await readableOrderIds(tx, [...orders]);
    for (const id of orders) if (!readable.has(id)) hidden.add(id);
  }
  if (lines.size > 0) {
    const rows = await tx<{ id: string }[]>`select id from sales.v_order_lines where id = any(${[...lines]}::uuid[])`;
    const readable = new Set(rows.map((r) => r.id));
    for (const id of lines) if (!readable.has(id)) hidden.add(id);
  }
  return hidden;
}
