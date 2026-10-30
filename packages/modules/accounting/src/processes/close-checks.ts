import type { ProcessContext } from "@erp/kernel";
import { controlReconciliation } from "../reports/control-reconciliation";

// The ten checks of design §4.14 that `period.close` runs and records as the sign-off. Each carries the figures it compared and a
// Spanish note the screens and the assistant show as the reason of a refusal.

export const CLOSE_CHECK_NAMES = [
  "drafts", "pending_approvals", "pending_failures", "undispatched_events", "control_receivable", "control_payable", "control_inventory",
  "suspense_zero", "rounding_within_tolerance", "contra_nature_balances",
] as const;
export type CloseCheckName = (typeof CLOSE_CHECK_NAMES)[number];

export interface CloseCheck {
  check: CloseCheckName;
  passed: boolean;
  value: Record<string, unknown>;
  note: string;
}

export interface ClosingPeriod {
  id: string;
  startsOn: string;
  endsOn: string;
}

/** `$ 1.234.567,00`, the money format of rule 23. */
export const money = (value: number): string => `$ ${new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function runCloseChecks(ctx: ProcessContext, period: ClosingPeriod, tolerance: number): Promise<CloseCheck[]> {
  const count = async (status: string): Promise<number> =>
    (await ctx.tx<{ n: number }[]>`
      select count(*)::int as n from accounting.entries
      where company_id = ${ctx.companyId} and status = ${status} and date between ${period.startsOn}::date and ${period.endsOn}::date`)[0]!.n;
  const checks: CloseCheck[] = [];

  const drafts = await count("draft");
  checks.push({
    check: "drafts", passed: drafts === 0, value: { count: drafts },
    note: drafts === 0 ? "Sin borradores en el período" : `Hay ${plural(drafts, "borrador", "borradores")} con fecha en el período: contabilízalos o anúlalos`,
  });

  const pending = await count("pending");
  checks.push({
    check: "pending_approvals", passed: pending === 0, value: { count: pending },
    note: pending === 0 ? "Sin comprobantes pendientes de aprobación" : `Hay ${plural(pending, "comprobante pendiente", "comprobantes pendientes")} de aprobación en el período`,
  });

  const [failures] = await ctx.tx<{ n: number }[]>`
    select count(*)::int as n from accounting.posting_failures
    where company_id = ${ctx.companyId} and status = 'pending' and event_date between ${period.startsOn}::date and ${period.endsOn}::date`;
  checks.push({
    check: "pending_failures", passed: failures!.n === 0, value: { count: failures!.n },
    note: failures!.n === 0 ? "Sin pendientes de contabilizar" : `Hay ${plural(failures!.n, "pendiente", "pendientes")} de contabilizar con fecha en el período`,
  });

  const [events] = await ctx.tx<{ n: number }[]>`
    select count(*)::int as n from kernel.outbox o
    where o.company_id = ${ctx.companyId} and o.dispatched_at is null
      and exists (select 1 from accounting.posting_rules r where r.company_id = o.company_id and r.event = o.event and r.is_active)
      and coalesce(case when o.payload->>'date' ~ '^\d{4}-\d{2}-\d{2}' then (o.payload->>'date')::date end, o.created_at::date)
          between ${period.startsOn}::date and ${period.endsOn}::date`;
  checks.push({
    check: "undispatched_events", passed: events!.n === 0, value: { count: events!.n },
    note: events!.n === 0 ? "Todos los eventos del período fueron despachados" : `Hay ${plural(events!.n, "evento", "eventos")} del período sin despachar al motor de contabilización`,
  });

  const control = await controlReconciliation(ctx, period.endsOn, period.startsOn, tolerance);
  for (const [name, label, side] of [["control_receivable", "cuentas por cobrar", control.receivable], ["control_payable", "cuentas por pagar", control.payable]] as const) {
    const passed = side.differences.length === 0;
    checks.push({
      check: name, passed,
      value: { ledger: side.ledger, open: side.open, differences: side.differences.slice(0, 20), count: side.differences.length },
      note: passed
        ? `${label[0]!.toUpperCase()}${label.slice(1)} cuadran con sus partidas abiertas (${money(side.ledger)})`
        : `${label[0]!.toUpperCase()}${label.slice(1)}: el libro marca ${money(side.ledger)} y las partidas abiertas ${money(side.open)}; ${plural(side.differences.length, "tercero difiere", "terceros difieren")} por más de ${money(tolerance)}`,
    });
  }

  const inventory = control.inventory;
  checks.push(
    !inventory.available
      ? { check: "control_inventory", passed: true, value: { available: false }, note: "Sin módulo de inventario: no hay existencias que cuadrar" }
      : {
          check: "control_inventory", passed: Math.abs(inventory.difference) <= tolerance, value: { ledger: inventory.ledger, stock: inventory.stock, difference: inventory.difference },
          note: Math.abs(inventory.difference) <= tolerance
            ? `El inventario contable coincide con las existencias valoradas (${money(inventory.ledger)})`
            : `El inventario contable (${money(inventory.ledger)}) difiere de las existencias valoradas (${money(inventory.stock)}) en ${money(inventory.difference)}`,
        },
  );

  const suspenseZero = Math.abs(control.suspense.balance) < 0.005;
  checks.push({
    check: "suspense_zero", passed: suspenseZero, value: { mapped: control.suspense.mapped, balance: control.suspense.balance, accounts: control.suspense.accounts },
    note: !control.suspense.mapped
      ? "No hay cuenta transitoria mapeada: nada que aclarar"
      : suspenseZero ? "La cuenta transitoria está en cero" : `La cuenta transitoria (partidas por aclarar) tiene saldo ${money(control.suspense.balance)} al cierre del período`,
  });

  const oversized = control.rounding.oversized;
  checks.push({
    check: "rounding_within_tolerance", passed: oversized.length === 0, value: { net: control.rounding.net, lines: control.rounding.lines, oversized: oversized.slice(0, 20) },
    note: oversized.length === 0
      ? `El ajuste al peso del período (${money(control.rounding.net)}) está dentro de la tolerancia`
      : `${plural(oversized.length, "línea de ajuste al peso supera", "líneas de ajuste al peso superan")} la tolerancia de ${money(tolerance)}`,
  });

  const contra = await ctx.tx<{ id: string; code: string; name: string; nature: string; balance: string }[]>`
    select a.id, a.code, a.name, a.nature, sum(case when a.nature = 'debit' then l.debit - l.credit else l.credit - l.debit end) as balance
    from accounting.entry_lines l
    join accounting.entries e on e.id = l.entry_id
    join accounting.accounts a on a.id = l.account_id
    where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and e.date <= ${period.endsOn}::date and accounting.can_view_account(l.account_id)
    group by a.id, a.code, a.name, a.nature
    having sum(case when a.nature = 'debit' then l.debit - l.credit else l.credit - l.debit end) < ${-tolerance}
    order by a.code`;
  checks.push({
    check: "contra_nature_balances", passed: contra.length === 0,
    value: { count: contra.length, accounts: contra.slice(0, 20).map((a) => ({ code: a.code, name: a.name, nature: a.nature, balance: Number(a.balance) })) },
    note: contra.length === 0
      ? "Ninguna cuenta tiene saldo contrario a su naturaleza"
      : `${plural(contra.length, "cuenta tiene", "cuentas tienen")} saldo contrario a su naturaleza: ${contra.slice(0, 5).map((a) => `${a.code} (${money(Number(a.balance))})`).join(", ")}${contra.length > 5 ? "…" : ""}`,
  });
  return checks;
}
