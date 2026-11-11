import { defineProcess, defineReport, ReportState, windowOf, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { FEATURE_COMMISSION_PLANS } from "../processes/commission-plan";

// Comisiones por vendedor (plan 2B.2 Task 30.4, Part G design PG §5.5; owner item 163; rule 20): one row per commission base (an invoice
// line billed from a pedido whose salesperson had a plan) of the period, by payee and status, with the plan, the invoice, the base, the
// frozen rate, the commission, what was accrued and reversed of it and what is still to accrue («Por causar»: an open base's commission
// less what it accrued net of reversals; a closed base, annulled, has nothing left). Every figure is in the company's currency (the bases
// keep pesos at the invoice's rate). Read through the masked views as the caller: the record rule of 0156 shows a salesperson only the
// bases of the plans that list them (sales.commission.consult_all lifts it), and a role that does not see the confidential rates and
// amounts reads them empty; a total over a column the caller cannot see is left out rather than shown as $ 0. The grid exports it (PDF,
// Excel, CSV) like every report.

const STATUS = ["all", "open", "closed"] as const;

const params = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    payeePartyId: z.uuid().optional(),
    status: z.enum(STATUS).default("all"),
  })
  .refine((p) => p.from <= p.to, { message: "La fecha inicial no puede ser posterior a la final" });

const money = (field: string, label: string, total = true): ReportColumn => ({ field, label, type: "money", currency: "company", mono: true, ...(total ? { total: "sum" as const } : {}) });

const columns: ReportColumn[] = [
  { field: "payee_name", label: "report.col.sales.payee", type: "text", link: { entity: "core.party", idField: "payee_party_id" } },
  { field: "plan_name", label: "report.col.sales.plan", type: "text", link: { entity: "sales.commission_plan", idField: "plan_id" } },
  { field: "invoice_number", label: "report.col.sales.invoice", type: "text", mono: true, link: { entity: "invoicing.invoice", idField: "invoice_id" } },
  { field: "invoice_date", label: "report.col.date", type: "date" },
  { field: "product_name", label: "report.col.sales.product", type: "text", link: { entity: "core.product", idField: "product_id" } },
  money("base", "report.col.sales.base"),
  { field: "rate_pct", label: "report.col.sales.rate", type: "number", mono: true },
  money("commission", "report.col.sales.commission"),
  money("accrued", "report.col.sales.accrued"),
  money("reversed", "report.col.sales.reversed"),
  money("open", "report.col.sales.open"),
];

const TOTALS = ["base", "commission", "accrued", "reversed", "open"] as const;

type Row = {
  id: string; invoice_id: string | null; invoice_number: string | null; invoice_date: string | null; plan_id: string | null; plan_name: string | null;
  payee_party_id: string | null; payee_name: string | null; product_id: string | null; product_name: string | null; status: string | null;
  base: string | null; rate_pct: string | null; commission: string | null; accrued: string | null; reversed: string | null;
};

const amount = (v: string | null): number | null => (v === null ? null : Number(v));
const cents = (v: number): number => Math.round(v * 100) / 100 || 0;

export const commissionsReportConsult = defineProcess({
  id: "sales.report.commissions",
  module: "sales",
  kind: "consult",
  feature: FEATURE_COMMISSION_PLANS,
  description: "Comisiones por vendedor: por beneficiario, período y estado, la base, la tasa, la comisión, lo causado, lo reversado y lo que falta por causar de cada línea facturada",
  input: z.object({ params, state: ReportState }),
  output: z.object({ rows: z.array(z.record(z.string(), z.unknown())), total: z.number(), aggregates: z.record(z.string(), z.unknown()).optional() }),
  handler: async (ctx, { params: p, state }) => {
    const [company] = await ctx.tx<{ currency: string }[]>`select currency_code::text as currency from kernel.companies where id = ${ctx.companyId}`;
    const rows = await ctx.tx<Row[]>`
      select b.id, b.invoice_id, b.invoice_number, b.invoice_date::text, b.plan_id, pl.name as plan_name, b.payee_party_id, pa.legal_name as payee_name,
             b.product_id, pr.description as product_name, b.status, b.base::text, b.rate_pct::text, b.commission::text, b.accrued::text, b.reversed::text
      from sales.v_commission_bases b
      left join sales.v_commission_plans pl on pl.id = b.plan_id
      left join core.v_parties pa on pa.id = b.payee_party_id
      left join core.v_products pr on pr.id = b.product_id
      where b.invoice_date between ${p.from}::date and ${p.to}::date
        and (${p.payeePartyId ?? null}::uuid is null or b.payee_party_id = ${p.payeePartyId ?? null}::uuid)
        and (${p.status} = 'all' or b.status = ${p.status})
      order by pa.legal_name nulls last, b.invoice_date, b.invoice_number, b.seq`;
    const masked = new Set<string>();
    const out = rows.map((r) => {
      const figures = { base: amount(r.base), commission: amount(r.commission), accrued: amount(r.accrued), reversed: amount(r.reversed) };
      const { commission, accrued, reversed } = figures;
      const open = commission === null || accrued === null || reversed === null ? null : r.status === "open" ? cents(Math.max(commission - (accrued - reversed), 0)) : 0;
      const row: Record<string, unknown> = {
        id: r.id, invoice_id: r.invoice_id, invoice_number: r.invoice_number ?? "", invoice_date: r.invoice_date, plan_id: r.plan_id, plan_name: r.plan_name ?? "",
        payee_party_id: r.payee_party_id, payee_name: r.payee_name ?? "", product_id: r.product_id, product_name: r.product_name ?? "", status: r.status,
        rate_pct: amount(r.rate_pct), ...figures, open,
      };
      for (const field of TOTALS) if (row[field] === null) masked.add(field);
      return row;
    });
    return windowOf(out, state, { totals: TOTALS.filter((f) => !masked.has(f)), extra: { from: p.from, to: p.to, status: p.status, valuesIn: company!.currency } });
  },
});

export const commissionsReport = defineReport({
  id: "sales.commissions",
  module: "sales",
  feature: FEATURE_COMMISSION_PLANS,
  label: "report.sales.commissions",
  params,
  consult: "sales.report.commissions",
  columns,
  totals: [...TOTALS],
  pdfTitle: "Comisiones por vendedor",
});

export const SALES_REPORT_PROCESSES = [commissionsReportConsult];
export const SALES_REPORTS = [commissionsReport];
