import { defineProcess, ProcessError } from "@erp/kernel";
import { z } from "zod";
import { refuse } from "./order";

// Order owner isolation (plan 2B.2 Task 39, owner item 29 of 2026-11-06, design §6, migration 0139). A pedido is read by its owner (the
// salesperson) and by whoever may run sales.order.reassign: that process is both the «all orders» permission the read policy owner_scope
// asks for (kernel.can_run_process; a company admin always may) and the only way to change the owner, the analogue of crm.opportunity.reassign
// for the cotizaciones. Normal sensitivity: it moves visibility inside the company, not money. It runs in any stage, a confirmed, delivered
// or cancelled pedido included (it does not change the document), and the row audit records the owner's diff with the process id.

const FEATURE = "sales.orders";
const id = z.uuid();

export const orderReassign = defineProcess({
  id: "sales.order.reassign",
  module: "sales",
  kind: "update",
  feature: FEATURE,
  description: "Asigna un pedido a otro vendedor; quien puede reasignar ve todos los pedidos de la empresa",
  input: z.object({ id, ownerId: id }).strict(),
  output: z.object({ id: z.string(), ownerId: z.string(), changed: z.boolean() }),
  handler: async (ctx, { id: orderId, ownerId }) => {
    const [order] = await ctx.tx<{ owner_id: string | null }[]>`select owner_id from sales.orders where id = ${orderId} for update`;
    if (!order) throw new ProcessError("not_found", `order ${orderId} not found`);
    // The new owner through sales' own definer helper (rule 3: never crm's), not kernel.memberships under the caller's RLS.
    const [member] = await ctx.tx<{ ok: boolean }[]>`select sales.is_company_member(${ownerId}::uuid) as ok`;
    if (!member?.ok) refuse("invalid_owner", ["El vendedor no pertenece a la empresa"]);
    if (order.owner_id === ownerId) return { id: orderId, ownerId, changed: false };
    await ctx.tx`update sales.orders set owner_id = ${ownerId}, owner_source = 'reassigned' where id = ${orderId}`;
    return { id: orderId, ownerId, changed: true };
  },
});

export const ORDER_OWNER_PROCESSES = [orderReassign];
