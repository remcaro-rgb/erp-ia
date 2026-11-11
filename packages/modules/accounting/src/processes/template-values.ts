import { ProcessError, type ProcessContext } from "@erp/kernel";
import type { LineInput } from "./entry-validate";

// A plantilla de comprobante may fix its values (accounting design §4.10): when `values_editable` is false, the fixed amount of each of
// its lines is the comprobante's, and so is the account it is on. The lines left open (no amount) stay for the user to fill.

const money = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

/** Refuses a comprobante whose lines change what a not-editable plantilla fixes. A plantilla with editable values (or none) is left alone. */
export async function assertTemplateValues(ctx: ProcessContext, templateId: string, lines: readonly LineInput[]): Promise<void> {
  const [template] = await ctx.tx<{ values_editable: boolean }[]>`select values_editable from accounting.entry_templates where id = ${templateId} and company_id = ${ctx.companyId}`;
  if (!template || template.values_editable) return;
  const fixed = await ctx.tx<{ line_no: number; account_id: string; side: string; amount: string | null; code: string }[]>`
    select l.line_no, l.account_id, l.side, l.amount, a.code
    from accounting.entry_template_lines l join accounting.accounts a on a.id = l.account_id
    where l.template_id = ${templateId} and l.amount is not null order by l.line_no`;
  const codes = [...new Set(lines.map((l) => l.accountCode).filter((v): v is string => !!v))];
  const byCode = codes.length === 0 ? [] : await ctx.tx<{ id: string; code: string }[]>`select id, code from accounting.accounts where company_id = ${ctx.companyId} and code = any(${codes}::text[])`;
  const problems: string[] = [];
  for (const row of fixed) {
    const line = lines[row.line_no - 1];
    const accountId = line?.accountId ?? byCode.find((a) => a.code === line?.accountCode)?.id;
    const value = row.side === "debit" ? line?.debit : line?.credit;
    const wanted = Number(row.amount);
    if (!line || accountId !== row.account_id || Math.abs((value ?? 0) - wanted) > 0.00005) {
      problems.push(`La plantilla fija la línea ${row.line_no} (${row.code}) en ${money(wanted)}; no se puede cambiar`);
    }
  }
  if (problems.length > 0) throw new ProcessError("invalid_input", "the template fixes its values", { details: problems });
}
