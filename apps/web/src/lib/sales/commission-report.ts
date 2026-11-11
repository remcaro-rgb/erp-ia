import "server-only";
import { withClaims, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";
import type { LoadReportOptions } from "@/lib/reports/load";

// The parameter bar of «Comisiones por vendedor» (plan 2B.2 Task 30.4, PG §5.5): the payees the caller may pick (those of the plans they
// see, through the masked views: a salesperson sees only their own plans' payees, the record rule of 0156) and where the bar starts (this
// month, up to today, in the company's calendar).

export async function commissionReportOptions(caller: Caller): Promise<LoadReportOptions> {
  return withClaims(processDeps().sql, caller.claims, async (tx) => {
    const [day] = await tx<{ today: string; first: string }[]>`
      select d::text as today, date_trunc('month', d)::date::text as first
      from (select (now() at time zone coalesce((select timezone from kernel.v_companies where id = ${caller.claims.active_company_id}), 'America/Bogota'))::date as d) t`;
    const payees = await tx<{ id: string; legal_name: string | null; document_number: string | null }[]>`
      select distinct pa.id, pa.legal_name, pa.document_number
      from sales.v_commission_plans p join core.v_parties pa on pa.id = p.payee_party_id order by pa.legal_name`;
    return {
      paramOptions: { payeePartyId: payees.map((p) => ({ value: p.id, label: [p.legal_name, p.document_number].filter(Boolean).join(" · ") })) },
      defaults: { from: day!.first, to: day!.today },
    };
  });
}
