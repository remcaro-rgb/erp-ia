import "server-only";
import { withClaims, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";
import type { LoadReportOptions } from "@/lib/reports/load";

// The parameter bar of «Trazabilidad de lotes» (plan 2B.2 Task 28.4, PG §3.6): the lots and serials the caller may pick, read through
// inventory's masked views as the caller (a lot as `code · producto · vence`, a serial as `número · producto`).

export async function lotTraceReportOptions(caller: Caller): Promise<LoadReportOptions> {
  return withClaims(processDeps().sql, caller.claims, async (tx) => {
    const lots = await tx<{ id: string; code: string; expires_on: string | null; product: string | null }[]>`
      select l.id, l.code, l.expires_on::text, p.description as product
      from inventory.v_lots l left join core.v_products p on p.id = l.product_id order by p.description, l.expires_on nulls last, l.code limit 500`;
    const serials = await tx<{ id: string; serial_no: string; product: string | null }[]>`
      select s.id, s.serial_no, p.description as product
      from inventory.v_serials s left join core.v_products p on p.id = s.product_id order by p.description, s.serial_no limit 500`;
    return {
      paramOptions: {
        lotId: lots.map((l) => ({ value: l.id, label: [l.code, l.product, l.expires_on].filter(Boolean).join(" · ") })),
        serialId: serials.map((s) => ({ value: s.id, label: [s.serial_no, s.product].filter(Boolean).join(" · ") })),
      },
    };
  });
}
