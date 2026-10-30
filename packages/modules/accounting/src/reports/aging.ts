import { defineProcess, defineReport, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { cents, reportInput, reportOutput, windowOf } from "./common";

// Cartera por edades (accounting design §5.11): the open items of receivable or payable accounts by party, in buckets of days past
// the due date at `asOf`: por vencer, 1–b1, b1+1–b2, b2+1–b3 and más de b3 (30 · 60 · 90 by default). Items come from
// `accounting.open_items`, which applies receipts and payments FIFO by due date and leaves restricted accounts out.

const params = z.object({
  kind: z.enum(["receivable", "payable"]),
  asOf: z.iso.date(),
  buckets: z.tuple([z.number().int().min(1), z.number().int().min(2), z.number().int().min(3)]).default([30, 60, 90]),
}).refine((p) => p.buckets[0] < p.buckets[1] && p.buckets[1] < p.buckets[2], { message: "Los rangos deben ir en orden ascendente" });

const columns: ReportColumn[] = [
  { field: "party_name", label: "report.col.party", type: "text", link: { entity: "core.party", idField: "party_id" } },
  { field: "party_document", label: "report.col.party_document", type: "text", mono: true },
  { field: "not_due", label: "report.aging.not_due", type: "money", total: "sum", mono: true },
  { field: "b1", label: "report.aging.b1", type: "money", total: "sum", mono: true },
  { field: "b2", label: "report.aging.b2", type: "money", total: "sum", mono: true },
  { field: "b3", label: "report.aging.b3", type: "money", total: "sum", mono: true },
  { field: "over", label: "report.aging.over", type: "money", total: "sum", mono: true },
  { field: "total", label: "report.col.total", type: "money", total: "sum", mono: true },
];

const BUCKETS = ["not_due", "b1", "b2", "b3", "over"] as const;

export const agingConsult = defineProcess({
  id: "accounting.report.aging",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Cartera por edades: partidas abiertas de cuentas por cobrar o por pagar por tercero y por días de vencimiento a una fecha",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const [b1, b2, b3] = p.buckets;
    const items = await ctx.tx<{ party_id: string; party_name: string | null; party_document: string | null; days: number; open: string }[]>`
      with groups as (
        select distinct left(a.code, 2) as grp, (m.role = 'receivable' or m.role like '%\_receivable') as is_receivable
        from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
        where m.company_id = ${ctx.companyId}
          and (m.role = 'receivable' or m.role like '%\_receivable' or m.role = 'payable' or m.role like '%\_payable')
      )
      select o.party_id, p.legal_name as party_name, p.document_number as party_document,
             (${p.asOf}::date - coalesce(o.due_date, o.date)) as days, o.open
      from accounting.open_items(${ctx.companyId}, ${p.asOf}::date) o
      join accounting.accounts a on a.id = o.account_id
      join groups g on g.grp = left(a.code, 2) and g.is_receivable = ${p.kind === "receivable"}
      left join core.v_parties p on p.id = o.party_id
      where o.open > 0`;
    const byParty = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const row = byParty.get(item.party_id) ?? { party_id: item.party_id, party_name: item.party_name ?? "", party_document: item.party_document ?? "", not_due: 0, b1: 0, b2: 0, b3: 0, over: 0, total: 0 };
      const bucket = item.days <= 0 ? "not_due" : item.days <= b1 ? "b1" : item.days <= b2 ? "b2" : item.days <= b3 ? "b3" : "over";
      row[bucket] = Number(row[bucket]) + Number(item.open);
      row.total = Number(row.total) + Number(item.open);
      byParty.set(item.party_id, row);
    }
    const rows = [...byParty.values()]
      .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "number" ? cents(v) : v])))
      .sort((a, c) => String(a.party_name).localeCompare(String(c.party_name)));
    return windowOf(rows, state, { totals: [...BUCKETS, "total"], extra: { kind: p.kind, asOf: p.asOf, buckets: p.buckets } });
  },
});

export const agingReport = defineReport({
  id: "accounting.aging",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.aging",
  params,
  consult: "accounting.report.aging",
  columns,
  totals: [...BUCKETS, "total"],
  pdfTitle: "Cartera por edades",
});
