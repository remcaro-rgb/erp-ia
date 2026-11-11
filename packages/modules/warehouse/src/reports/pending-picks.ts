import { defineProcess, defineReport, ReportState, translatorFor, windowOf, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { FIRM_ORDER_STAGES } from "../processes/common";

// «Pendientes por alistar» (plan 2B.2 Task 29.4, PG §4.4; rules 3, 14, 20): the confirmed pedidos (confirmed or partly delivered) that still
// have goods to deliver and no confirmed alistamiento, oldest confirmation first: when it was confirmed, the pedido (a link), the customer,
// the bodega, how many of its lines and how much is still to pick (goods that keep stock only, what non-voided entregas did not take), and
// the open alistamiento when one is under way (its number and stage). A cancelled or delivered pedido, one not confirmed, or one whose
// alistamiento is confirmed, is not listed. Warehouse reads the pedido only through sales' published sales.v_pick_order_lines, the
// customer through core.v_parties and the bodega through inventory.v_warehouses, as the caller (a masked customer reads empty, rule 14).
// The grid exports it (PDF, Excel, CSV) like every report; the assistant gets it as a consult tool (capped and masked, rule 17).

/** The alistamientos' feature (features.ts imports this file: the id is repeated, not imported). */
const FEATURE_PICKING = "warehouse.picking";
const day = z.iso.date();
const params = z
  .object({ warehouseId: z.uuid().optional(), from: day.optional(), to: day.optional() })
  .refine((p) => !p.from || !p.to || p.from <= p.to, { message: "La fecha inicial no puede ser posterior a la final" });

const columns: ReportColumn[] = [
  { field: "confirmed_at", label: "report.pending_picks.col.confirmed_at", type: "date" },
  { field: "order_number", label: "report.pending_picks.col.order", type: "text", mono: true, link: { entity: "sales.order", idField: "order_id" } },
  { field: "party_name", label: "report.pending_picks.col.customer", type: "text", link: { entity: "core.party", idField: "party_id" } },
  { field: "warehouse_name", label: "report.pending_picks.col.warehouse", type: "text" },
  { field: "lines", label: "report.pending_picks.col.lines", type: "number", mono: true },
  { field: "qty_pending", label: "report.pending_picks.col.qty_pending", type: "number", mono: true, total: "sum" },
  { field: "pick_number", label: "report.pending_picks.col.pick", type: "text", mono: true, link: { entity: "warehouse.pick", idField: "pick_id" } },
  { field: "pick_stage", label: "report.pending_picks.col.pick_stage", type: "text" },
];

type Row = {
  order_id: string; order_number: string | null; party_id: string | null; party_name: string | null; warehouse_name: string | null; confirmed_at: string | null;
  lines: number; qty_pending: string; pick_id: string | null; pick_number: string | null; pick_stage: string | null;
};

export const pendingPicksConsult = defineProcess({
  id: "warehouse.report.pending_picks",
  module: "warehouse",
  kind: "consult",
  feature: FEATURE_PICKING,
  description:
    "Pendientes por alistar: los pedidos confirmados con mercancía por entregar y sin alistamiento confirmado, del más antiguo al más reciente, con lo que falta por alistar y el alistamiento abierto si lo hay",
  input: z.object({ params, state: ReportState }),
  output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), total: z.number(), aggregates: z.record(z.string(), z.unknown()).optional() }),
  handler: async (ctx, { params: p, state }) => {
    const t = translatorFor(ctx.locale);
    const rows = await ctx.tx<Row[]>`
      with pending as (
        select o.order_id, o.order_number, o.party_id, o.warehouse_id, min(o.confirmed_at) as confirmed_at,
               count(*)::int as lines, sum(o.qty - o.committed_qty) as qty_pending
        from sales.v_pick_order_lines o
        join core.v_product_stock ps on ps.id = o.product_id and ps.kind <> 'service' and ps.track_stock
        where o.company_id = ${ctx.companyId} and o.order_stage = any(${[...FIRM_ORDER_STAGES]}::text[]) and o.order_status <> 'voided'
          and o.qty > o.committed_qty
          and (${p.warehouseId ?? null}::uuid is null or o.warehouse_id = ${p.warehouseId ?? null}::uuid)
        group by o.order_id, o.order_number, o.party_id, o.warehouse_id
      )
      select x.order_id, x.order_number, x.party_id, pa.legal_name as party_name, w.name as warehouse_name,
             (x.confirmed_at at time zone coalesce(c.timezone, 'America/Bogota'))::date::text as confirmed_at,
             x.lines, x.qty_pending::text, pk.id as pick_id, pk.number as pick_number, pk.stage as pick_stage
      from pending x
      join kernel.companies c on c.id = ${ctx.companyId}
      left join core.v_parties pa on pa.id = x.party_id
      left join inventory.v_warehouses w on w.id = x.warehouse_id
      left join lateral (
        select id, number, stage from warehouse.v_picks k
        where k.order_id = x.order_id and k.status <> 'voided' and k.stage <> 'confirmed' order by k.seq desc limit 1
      ) pk on true
      where not exists (select 1 from warehouse.v_picks k where k.order_id = x.order_id and k.status <> 'voided' and k.stage = 'confirmed')
        and (${p.from ?? null}::date is null or (x.confirmed_at at time zone coalesce(c.timezone, 'America/Bogota'))::date >= ${p.from ?? null}::date)
        and (${p.to ?? null}::date is null or (x.confirmed_at at time zone coalesce(c.timezone, 'America/Bogota'))::date <= ${p.to ?? null}::date)
      order by x.confirmed_at nulls last, x.order_number`;
    const out = rows.map((r) => ({
      ...r,
      order_number: r.order_number ?? "",
      party_name: r.party_name ?? "",
      warehouse_name: r.warehouse_name ?? "",
      qty_pending: Number(r.qty_pending),
      pick_stage: r.pick_stage ? (t(`warehouse.values.pick_stage.${r.pick_stage}`) ?? r.pick_stage) : null,
    }));
    return windowOf(out, state, { totals: ["qty_pending"] });
  },
});

export const pendingPicksReport = defineReport({
  id: "warehouse.pending_picks",
  module: "warehouse",
  feature: FEATURE_PICKING,
  label: "report.warehouse.pending_picks",
  params,
  consult: "warehouse.report.pending_picks",
  columns,
  pdfTitle: "Pendientes por alistar",
});

export const WAREHOUSE_REPORTS = [pendingPicksReport];
export const REPORT_PROCESSES = [pendingPicksConsult];
