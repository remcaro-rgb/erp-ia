import { defineProcess, defineReport, ProcessError, ReportState, translatorFor, windowOf, type ReportColumn } from "@erp/kernel";
import { z } from "zod";

// «Trazabilidad de lotes» (plan 2B.2 Task 28.4, PG §3.6; rules 14, 17, 20, 21): the recall report. For one lot or one serial, every movement
// that moved it (optionally in a date range), oldest first, with its date, kind, bodega, quantity (signed, in the product's unit), the
// movement (a link to its record, whose document links lead on to the entrega or devolución) and its reference (the source document's
// number), and the customer a sale issue or a sale return answered to (inventory.movements.party_id, Task 28.1: no sales table is read,
// rule 3); then one row per bodega that holds it today. Everything is read as the caller through inventory's and core's masked views, so a
// customer the caller's role masks reads empty (rule 14). The assistant gets it as a consult tool (capped and masked, rule 17).

const FEATURE = "inventory.stock";
const day = z.iso.date();

const params = z.object({ lotId: z.uuid().optional(), serialId: z.uuid().optional(), from: day.optional(), to: day.optional() });

const columns: ReportColumn[] = [
  { field: "date", label: "report.col.date", type: "date" },
  { field: "kind", label: "report.lot_trace.col.kind", type: "text" },
  { field: "warehouse", label: "report.lot_trace.col.warehouse", type: "text" },
  { field: "qty", label: "report.lot_trace.col.qty", type: "number", mono: true },
  { field: "number", label: "report.col.number", type: "text", mono: true, link: { entity: "inventory.movement", idField: "movement_id" } },
  { field: "reference", label: "report.lot_trace.col.reference", type: "text", mono: true },
  { field: "customer", label: "report.lot_trace.col.customer", type: "text", link: { entity: "core.party", idField: "party_id" } },
];

export const lotTraceConsult = defineProcess({
  id: "inventory.report.lot_trace",
  module: "inventory",
  kind: "consult",
  feature: FEATURE,
  description:
    "Trazabilidad de un lote o de un serial (para un retiro del mercado): cada movimiento con su fecha, tipo, bodega, cantidad, documento y el cliente al que se entregó o que lo devolvió, y la existencia actual por bodega",
  input: z.object({ params, state: ReportState }),
  output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), total: z.number(), aggregates: z.record(z.string(), z.unknown()).optional() }),
  handler: async (ctx, { params: p, state }) => {
    if (Boolean(p.lotId) === Boolean(p.serialId)) {
      throw new ProcessError("invalid_input", "lot_trace needs a lot or a serial", { details: ["Indica un lote o un serial, no los dos"] });
    }
    if (p.from && p.to && p.from > p.to) throw new ProcessError("invalid_input", "the range is reversed", { details: ["La fecha inicial no puede ser posterior a la final"] });
    const t = translatorFor(ctx.locale);
    const [subject] = p.lotId
      ? await ctx.tx<{ code: string; expires_on: string | null; product_id: string }[]>`
          select code, expires_on::text, product_id from inventory.v_lots where id = ${p.lotId} and company_id = ${ctx.companyId}`
      : await ctx.tx<{ code: string; expires_on: string | null; product_id: string }[]>`
          select serial_no as code, null::text as expires_on, product_id from inventory.v_serials where id = ${p.serialId!} and company_id = ${ctx.companyId}`;
    if (!subject) throw new ProcessError("invalid_input", "lot or serial not found", { details: [p.lotId ? "El lote no existe o no es visible" : "El serial no existe o no es visible"] });
    const lot = p.lotId ?? null;
    const serial = p.serialId ?? null;
    const moves = await ctx.tx<{ movement_id: string; date: string; kind: string; number: string | null; reference: string | null; warehouse: string | null; party_id: string | null; customer: string | null; qty: string }[]>`
      select m.id as movement_id, m.date::text as date, m.kind, m.number, m.reference, w.name as warehouse, m.party_id, p.legal_name as customer, sum(l.qty)::text as qty
      from inventory.v_movement_lines l
      join inventory.v_movements m on m.id = l.movement_id
      left join inventory.v_warehouses w on w.id = m.warehouse_id
      left join core.v_parties p on p.id = m.party_id
      where l.company_id = ${ctx.companyId} and m.status = 'saved'
        and (${lot}::uuid is null or l.lot_id = ${lot}::uuid) and (${serial}::uuid is null or l.serial_id = ${serial}::uuid)
        and (${p.from ?? null}::date is null or m.date >= ${p.from ?? null}::date) and (${p.to ?? null}::date is null or m.date <= ${p.to ?? null}::date)
      group by m.id, m.date, m.kind, m.number, m.reference, w.name, m.party_id, p.legal_name, m.seq
      order by m.date, m.seq`;
    const stock = await ctx.tx<{ warehouse: string | null; on_hand: string }[]>`
      select w.name as warehouse, sum(s.on_hand)::text as on_hand
      from inventory.v_stock_levels s left join inventory.v_warehouses w on w.id = s.warehouse_id
      where s.company_id = ${ctx.companyId} and (${lot}::uuid is null or s.lot_id = ${lot}::uuid) and (${serial}::uuid is null or s.serial_id = ${serial}::uuid)
      group by w.name having sum(s.on_hand) <> 0 order by w.name`;
    const rows: Record<string, unknown>[] = [
      ...moves.map((m) => ({
        row_kind: "movement", movement_id: m.movement_id, date: m.date, kind: t(`inventory.values.movement_kind.${m.kind}`) ?? m.kind, warehouse: m.warehouse, qty: Number(m.qty),
        number: m.number, reference: m.reference, party_id: m.party_id, customer: m.party_id ? m.customer : null,
      })),
      ...stock.map((s) => ({
        row_kind: "stock", movement_id: null, date: null, kind: t("report.lot_trace.on_hand") ?? "on_hand", warehouse: s.warehouse, qty: Number(s.on_hand),
        number: null, reference: null, party_id: null, customer: null,
      })),
    ];
    const onHand = stock.reduce((sum, s) => sum + Number(s.on_hand), 0);
    return windowOf(rows, state, { extra: { lotCode: subject.code, expiresOn: subject.expires_on, productId: subject.product_id, onHand, customers: new Set(moves.flatMap((m) => (m.party_id ? [m.party_id] : []))).size } });
  },
});

export const lotTraceReport = defineReport({
  id: "inventory.lot_trace",
  module: "inventory",
  feature: FEATURE,
  label: "report.inventory.lot_trace",
  params,
  consult: "inventory.report.lot_trace",
  columns,
  pdfTitle: "Trazabilidad de lotes",
});

export const INVENTORY_REPORTS = [lotTraceReport];
export const REPORT_PROCESSES = [lotTraceConsult];
