import "server-only";
import { withClaims, type Caller } from "@erp/kernel";
import { linkableEntities } from "@/lib/grid/links";
import { processDeps } from "@/lib/server/runtime";
import type { LoadReportOptions } from "@/lib/reports/load";

// The parameter bar of «Trazabilidad de lotes» (plan 2B.2 Task 28.4, PG §3.6): the lots and serials the caller may pick, read through
// inventory's masked views as the caller (a lot as `code · producto · vence`, a serial as `número · producto`). Task 28.5 (rule 21): the
// heading names the lot or serial the report runs on and links to its record when the caller may open it.

/** The heading of the report: each lot and serial the bar offers by id, its code or number, and whether its record opens. */
export interface LotTraceHeading {
  lots: Record<string, { code: string; product: string | null }>;
  serials: Record<string, { code: string; product: string | null }>;
  lotLinkable: boolean;
  serialLinkable: boolean;
}

async function subjects(caller: Caller) {
  return withClaims(processDeps().sql, caller.claims, async (tx) => {
    const lots = await tx<{ id: string; code: string; expires_on: string | null; product: string | null }[]>`
      select l.id, l.code, l.expires_on::text, p.description as product
      from inventory.v_lots l left join core.v_products p on p.id = l.product_id order by p.description, l.expires_on nulls last, l.code limit 500`;
    const serials = await tx<{ id: string; serial_no: string; product: string | null }[]>`
      select s.id, s.serial_no, p.description as product
      from inventory.v_serials s left join core.v_products p on p.id = s.product_id order by p.description, s.serial_no limit 500`;
    return { lots, serials };
  });
}

const optionsOf = ({ lots, serials }: Awaited<ReturnType<typeof subjects>>): LoadReportOptions => ({
  paramOptions: {
    lotId: lots.map((l) => ({ value: l.id, label: [l.code, l.product, l.expires_on].filter(Boolean).join(" · ") })),
    serialId: serials.map((s) => ({ value: s.id, label: [s.serial_no, s.product].filter(Boolean).join(" · ") })),
  },
});

export async function lotTraceReportOptions(caller: Caller): Promise<LoadReportOptions> {
  return optionsOf(await subjects(caller));
}

/** The bar's options and the heading's data of the report page (Task 28.5). */
export async function lotTracePage(caller: Caller): Promise<{ options: LoadReportOptions; heading: LotTraceHeading }> {
  const deps = processDeps();
  const [read, linkable] = await Promise.all([subjects(caller), linkableEntities(deps, caller.claims, ["inventory.lot", "inventory.serial"])]);
  return {
    options: optionsOf(read),
    heading: {
      lots: Object.fromEntries(read.lots.map((l) => [l.id, { code: l.code, product: l.product }])),
      serials: Object.fromEntries(read.serials.map((s) => [s.id, { code: s.serial_no, product: s.product }])),
      lotLinkable: linkable.has("inventory.lot"),
      serialLinkable: linkable.has("inventory.serial"),
    },
  };
}
