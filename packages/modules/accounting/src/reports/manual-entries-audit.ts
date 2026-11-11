import { defineProcess, defineReport, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { reportInput, reportOutput, windowOf } from "./common";

// Extracto de comprobantes manuales para el auditor (accounting design §5.12.5, ISA 240): every posted entry that no rule wrote, with
// creator, submitter, poster, timestamps, whether it was posted after the period's first close, whether the amount is a round one,
// the attachments, the lines and the amount.

const params = z.object({ from: z.iso.date(), to: z.iso.date(), roundThreshold: z.number().positive().default(1_000_000) });

const columns: ReportColumn[] = [
  { field: "number", label: "report.col.number", type: "text", mono: true, link: { entity: "accounting.entry", idField: "entry_id" } },
  { field: "date", label: "report.col.date", type: "date" },
  { field: "journal_code", label: "report.col.journal", type: "text", mono: true },
  { field: "description", label: "report.col.description", type: "text" },
  { field: "created_by_name", label: "report.col.created_by", type: "text" },
  { field: "submitted_by_name", label: "report.col.submitted_by", type: "text" },
  { field: "posted_by_name", label: "report.col.posted_by", type: "text" },
  { field: "created_at", label: "report.col.created_at", type: "datetime" },
  { field: "posted_at", label: "report.col.posted_at", type: "datetime" },
  { field: "posted_after_close", label: "report.col.posted_after_close", type: "boolean" },
  { field: "round_amount", label: "report.col.round_amount", type: "boolean" },
  { field: "attachments", label: "report.col.attachments", type: "number", mono: true },
  { field: "lines", label: "report.col.lines", type: "number", mono: true },
  { field: "amount", label: "report.col.amount", type: "money", currency: "company", total: "sum", mono: true },
];

export const manualEntriesAuditConsult = defineProcess({
  id: "accounting.report.manual_entries_audit",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Extracto de comprobantes manuales contabilizados para el auditor: quién los creó, envió y aprobó, cuándo, si fueron posteriores al cierre, si el valor es redondo y sus soportes",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const rows = await ctx.tx<Record<string, unknown>[]>`
      with first_close as (
        select period_id, min(created_at) as at
        from (select period_id, created_at from accounting.period_close_checks where company_id = ${ctx.companyId} group by period_id, created_at having bool_and(passed)) x
        group by period_id
      )
      select e.id as entry_id, e.number, e.date::text as date, j.code as journal_code, e.description, e.origin, e.status,
             cu.full_name as created_by_name, su.full_name as submitted_by_name, pu.full_name as posted_by_name,
             e.created_at, e.submitted_at, e.posted_at,
             coalesce(e.posted_at > fc.at, false) as posted_after_close,
             greatest(e.total_debit, e.total_credit) > 0 and mod(greatest(e.total_debit, e.total_credit), ${p.roundThreshold}::numeric) = 0 as round_amount,
             (select count(*)::int from kernel.attachments a where a.company_id = e.company_id and a.entity = 'accounting.entry' and a.record_id = e.id and a.removed_at is null) as attachments,
             (select count(*)::int from accounting.entry_lines l where l.entry_id = e.id) as lines,
             greatest(e.total_debit, e.total_credit)::float8 as amount
      from accounting.entries e
      join accounting.journals j on j.id = e.journal_id
      left join first_close fc on fc.period_id = e.period_id
      left join kernel.v_users cu on cu.id = e.created_by
      left join kernel.v_users su on su.id = e.submitted_by
      left join kernel.v_users pu on pu.id = e.posted_by
      where e.company_id = ${ctx.companyId} and e.status = 'posted' and e.origin <> 'auto' and e.date between ${p.from}::date and ${p.to}::date
      order by e.date, e.number`;
    const flagged = rows.filter((r) => r.round_amount || r.posted_after_close).length;
    return windowOf(rows, state, { totals: ["amount"], extra: { flagged, roundThreshold: p.roundThreshold } });
  },
});

export const manualEntriesAuditReport = defineReport({
  id: "accounting.manual_entries_audit",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.manual_entries_audit",
  params,
  consult: "accounting.report.manual_entries_audit",
  columns,
  totals: ["amount"],
  pdfTitle: "Comprobantes manuales",
});
