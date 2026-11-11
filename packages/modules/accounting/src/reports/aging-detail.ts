import { defineProcess, defineReport, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { AGING_BUCKETS, agingBucket, agingItems, agingParams } from "./aging";
import { cents, reportInput, reportOutput, windowOf } from "./common";

// Detalle de cartera (owner 2026-11-11): the drill-down of a figure of the Cartera por edades. A click on an amount opens, in a tab of its
// own, the open items that make it: those of the row's party (or every party, from a currency subtotal) in the clicked bucket (or all of
// them, from «Total»), each with the comprobante that made it, its date, its due date, the days past due and what remains open. The
// parameters are the aging's own (kind, asOf, buckets, currency) plus the party and the bucket, so the figures match the aging's cell.

const params = agingParams
  .extend({
    partyId: z.uuid().optional(),
    bucket: z.enum(["all", ...AGING_BUCKETS]).default("all"),
    /** In «Moneda del documento», the currency of the clicked row. */
    currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  })
  .refine((p) => p.buckets[0] < p.buckets[1] && p.buckets[1] < p.buckets[2], { message: "Los rangos deben ir en orden ascendente" });

const columns: ReportColumn[] = [
  { field: "party_name", label: "report.col.party", type: "text", link: { entity: "core.party", idField: "party_id" } },
  { field: "number", label: "report.col.number", type: "text", mono: true, link: { entity: "accounting.entry", idField: "entry_id" } },
  { field: "description", label: "report.col.description", type: "text" },
  { field: "date", label: "report.col.date", type: "date" },
  { field: "due_date", label: "report.aging_detail.due_date", type: "date" },
  { field: "days", label: "report.aging_detail.days", type: "number", mono: true },
  { field: "bucket", label: "report.aging_detail.bucket", type: "text" },
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true },
  { field: "currency", label: "report.col.currency", type: "text", mono: true },
  { field: "open", label: "report.aging_detail.open", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
];

export const agingDetailConsult = defineProcess({
  id: "accounting.report.aging_detail",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Detalle de cartera: los documentos abiertos que forman una cifra de la cartera por edades (un tercero, un rango de días, a una fecha)",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const byDocument = p.currency === "document";
    const [company] = await ctx.tx<{ currency: string }[]>`select currency_code::text as currency from kernel.companies where id = ${ctx.companyId}`;
    const companyCurrency = company!.currency;
    const rows: Record<string, unknown>[] = [];
    for (const item of await agingItems(ctx, p)) {
      if (p.partyId && item.party_id !== p.partyId) continue;
      const currency = byDocument ? item.currency : companyCurrency;
      if (byDocument && p.currencyCode && currency !== p.currencyCode) continue;
      const amount = Number(byDocument ? item.open_doc : item.open);
      if (amount === 0) continue;
      const bucket = agingBucket(amount, item.days, p.buckets);
      if (p.bucket !== "all" && bucket !== p.bucket) continue;
      rows.push({
        row_kind: "detail",
        party_id: item.party_id,
        party_name: item.party_name ?? "",
        entry_id: item.entry_id,
        number: item.number ?? "",
        description: item.description ?? "",
        date: item.date,
        due_date: item.due_date,
        days: item.days,
        bucket: `report.aging.${bucket}`,
        account_code: item.account_code,
        currency,
        open: cents(amount),
      });
    }
    const extra = { kind: p.kind, asOf: p.asOf, buckets: p.buckets, currency: p.currency, ...(byDocument ? {} : { valuesIn: companyCurrency }) };
    // The footer adds one currency only: in «Moneda del documento» the drill-down is of one currency (the clicked row's).
    const single = !byDocument || new Set(rows.map((r) => r.currency)).size <= 1;
    return windowOf(rows, state, { ...(single ? { totals: ["open"] } : {}), extra });
  },
});

export const agingDetailReport = defineReport({
  id: "accounting.aging_detail",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.aging_detail",
  params,
  consult: "accounting.report.aging_detail",
  columns,
  totals: ["open"],
  pdfTitle: "Detalle de cartera",
});
