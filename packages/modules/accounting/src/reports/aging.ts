import { defineProcess, defineReport, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { cents, reportInput, reportOutput, windowOf } from "./common";

// Cartera por edades (accounting design §5.11): the open items of receivable or payable accounts by party, in buckets of days past
// the due date at `asOf`: por vencer, 1–b1, b1+1–b2, b2+1–b3 and más de b3 (30 · 60 · 90 by default). Items come from
// `accounting.open_items`, which leaves restricted accounts out and applies receipts and payments FIFO by due date, or, for the
// receivables of a company with the payments module, by what each recibo de caja applied to each invoice and each credit note to its
// invoice (migration 0112). Its credit items (a saldo a favor beyond every document) and advance items (customer_advances) are
// negative and go to «Anticipos y saldos a favor»; the total is net of them.
// «Moneda» (plan 2B.2 Task 34.7, FX §7): «Equivalente en COP» (`company`, the default: every figure in the company's currency, the footer
// totals every party) or «Moneda del documento» (`document`: each item in its own currency, open_doc, the rows grouped by currency with a
// subtotal row per currency and no grand total, since no report adds two currencies into one figure). Every money column names its
// currency through the row's `currency` column.

const params = z.object({
  kind: z.enum(["receivable", "payable"]),
  asOf: z.iso.date(),
  buckets: z.tuple([z.number().int().min(1), z.number().int().min(2), z.number().int().min(3)]).default([30, 60, 90]),
  currency: z.enum(["company", "document"]).default("company"),
}).refine((p) => p.buckets[0] < p.buckets[1] && p.buckets[1] < p.buckets[2], { message: "Los rangos deben ir en orden ascendente" });

const columns: ReportColumn[] = [
  { field: "party_name", label: "report.col.party", type: "text", link: { entity: "core.party", idField: "party_id" } },
  { field: "party_document", label: "report.col.party_document", type: "text", mono: true },
  { field: "currency", label: "report.col.currency", type: "text", mono: true },
  { field: "not_due", label: "report.aging.not_due", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
  { field: "b1", label: "report.aging.b1", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
  { field: "b2", label: "report.aging.b2", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
  { field: "b3", label: "report.aging.b3", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
  { field: "over", label: "report.aging.over", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
  { field: "credits", label: "report.aging.credits", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
  { field: "total", label: "report.col.total", type: "money", currency: { field: "currency" }, total: "sum", mono: true },
];

const BUCKETS = ["not_due", "b1", "b2", "b3", "over", "credits"] as const;

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
    const byDocument = p.currency === "document";
    const [company] = await ctx.tx<{ currency: string }[]>`select currency_code::text as currency from kernel.companies where id = ${ctx.companyId}`;
    const items = await ctx.tx<{ party_id: string; party_name: string | null; party_document: string | null; days: number; open: string; currency: string; open_doc: string }[]>`
      with groups as (
        select distinct left(a.code, 2) as grp, (m.role = 'receivable' or m.role like '%\_receivable') as is_receivable
        from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
        where m.company_id = ${ctx.companyId}
          and (m.role = 'receivable' or m.role like '%\_receivable' or m.role = 'payable' or m.role like '%\_payable')
      )
      select o.party_id, p.legal_name as party_name, p.document_number as party_document,
             (${p.asOf}::date - coalesce(o.due_date, o.date)) as days, o.open, o.currency, o.open_doc
      from accounting.open_items(${ctx.companyId}, ${p.asOf}::date) o
      join accounting.accounts a on a.id = o.account_id
      left join groups g on g.grp = left(a.code, 2) and g.is_receivable = ${p.kind === "receivable"}
      left join core.v_parties p on p.id = o.party_id
      where o.open <> 0 and (g.grp is not null or (o.kind = 'advance' and ${p.kind === "receivable"}))`;
    const companyCurrency = company!.currency;
    const byParty = new Map<string, Record<string, unknown>>();
    for (const item of items) {
      const currency = byDocument ? item.currency : companyCurrency;
      const amount = Number(byDocument ? item.open_doc : item.open);
      if (amount === 0) continue;
      const key = `${currency}|${item.party_id}`;
      const row = byParty.get(key) ?? { party_id: item.party_id, party_name: item.party_name ?? "", party_document: item.party_document ?? "", currency, row_kind: "detail", not_due: 0, b1: 0, b2: 0, b3: 0, over: 0, credits: 0, total: 0 };
      const bucket = amount < 0 ? "credits" : item.days <= 0 ? "not_due" : item.days <= b1 ? "b1" : item.days <= b2 ? "b2" : item.days <= b3 ? "b3" : "over";
      row[bucket] = Number(row[bucket]) + amount;
      row.total = Number(row.total) + amount;
      byParty.set(key, row);
    }
    const rounded = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "number" ? cents(v) : v]));
    const details = [...byParty.values()].map(rounded)
      .sort((a, c) => String(a.currency).localeCompare(String(c.currency)) || String(a.party_name).localeCompare(String(c.party_name)));
    const extra = { kind: p.kind, asOf: p.asOf, buckets: p.buckets, currency: p.currency, ...(byDocument ? {} : { valuesIn: companyCurrency }) };
    if (!byDocument) return windowOf(details, state, { totals: [...BUCKETS, "total"], extra });
    // One subtotal row closing each currency's group, and no grand total: the footer would add pesos and dollars.
    const rows: Record<string, unknown>[] = [];
    for (const currency of [...new Set(details.map((r) => String(r.currency)))]) {
      const group = details.filter((r) => r.currency === currency);
      const subtotal: Record<string, unknown> = { party_id: null, party_name: `Subtotal ${currency}`, party_document: "", currency, row_kind: "subtotal" };
      for (const field of [...BUCKETS, "total"]) subtotal[field] = cents(group.reduce((s, r) => s + Number(r[field]), 0));
      rows.push(...group, subtotal);
    }
    return windowOf(rows, state, { extra });
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
