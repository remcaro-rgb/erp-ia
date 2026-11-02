import { defineProcess, ProcessError, visibleExtra } from "@erp/kernel";
import { z } from "zod";
import { companyPack, defined, invalid, refuseDuplicate } from "./common";
import { extraForCreate, extraForUpdate } from "./extra";
import { extra, extraFree, extraPatch, id, idOutput, name, rowOutput } from "./schemas";

// The chart of accounts (accounting design §4.1, §6). A company grows its chart below the subcuenta level only: it creates
// auxiliaries (8 or more digits) under a subcuenta or another auxiliary that has no lines yet.

const CODE_KEY = "accounts_company_id_code_key";
const nature = z.enum(["debit", "credit"]);
const flags = {
  requiresParty: z.boolean().optional(),
  requiresInvoiceReady: z.boolean().optional(),
  requiresCostCenter: z.boolean().optional(),
  requiresOpenAuxiliary: z.boolean().optional(),
  requiresItem: z.boolean().optional(),
  requiresBusinessUnit: z.boolean().optional(),
};
const statementSection = z.string().trim().min(1).max(100).optional();

export const accountCreate = defineProcess({
  id: "accounting.account.create",
  module: "accounting",
  kind: "create",
  feature: "accounting.ledger",
  description: "Crea una cuenta auxiliar del plan de cuentas bajo una subcuenta sin movimientos",
  input: z.object({ code: z.string().trim().regex(/^\d+$/, "El código solo lleva dígitos"), name, nature: nature.optional(), ...flags, statementSection, extra, extraFree: extraFree.optional() }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const pack = await companyPack(ctx);
    const own = pack.validateAccountCode(input.code);
    if (!own.ok) throw invalid(`invalid account code ${input.code}`, own.reason);
    if (own.level !== "auxiliary") {
      throw invalid(`level ${own.level} cannot be created by a company`, "Solo se pueden crear cuentas auxiliares (8 o más dígitos) bajo una subcuenta; el plan hasta subcuenta lo trae el país");
    }
    const [parent] = await ctx.tx<{ id: string; code: string; level: string; nature: "debit" | "credit"; requires_party: boolean; requires_invoice_ready: boolean; requires_cost_center: boolean; requires_open_auxiliary: boolean; requires_item: boolean; requires_business_unit: boolean; statement_section: string | null }[]>`
      select id, code, level, nature, requires_party, requires_invoice_ready, requires_cost_center, requires_open_auxiliary, requires_item, requires_business_unit, statement_section
      from accounting.accounts
      where company_id = ${ctx.companyId} and length(code) < ${input.code.length} and ${input.code} like code || '%'
      order by length(code) desc limit 1 for update`;
    if (!parent) throw invalid(`no parent account for ${input.code}`, "No existe una cuenta madre para ese código");
    const check = pack.validateAccountCode(input.code, parent.code);
    if (!check.ok) throw invalid(`invalid account code ${input.code}`, check.reason);
    if (parent.level !== "subaccount" && parent.level !== "auxiliary") {
      throw invalid(`parent ${parent.code} is a ${parent.level}`, "El auxiliar debe colgar de una subcuenta (6 dígitos) o de otro auxiliar");
    }
    const [used] = await ctx.tx<{ used: boolean }[]>`select exists (select 1 from accounting.entry_lines where account_id = ${parent.id}) as used`;
    if (used!.used) throw invalid(`parent ${parent.code} has lines`, "La cuenta padre ya tiene movimientos");
    const custom = await extraForCreate(ctx, "accounting.account", "accounting.account.create", input);
    const [inserted] = await refuseDuplicate("accounting.account.create", CODE_KEY, `Ya existe la cuenta ${input.code}`, () => ctx.tx<{ id: string }[]>`
      insert into accounting.accounts ${ctx.tx({
        company_id: ctx.companyId,
        code: input.code,
        name: input.name,
        nature: input.nature ?? parent.nature,
        allows_movement: true,
        requires_party: input.requiresParty ?? parent.requires_party,
        requires_invoice_ready: input.requiresInvoiceReady ?? parent.requires_invoice_ready,
        requires_cost_center: input.requiresCostCenter ?? parent.requires_cost_center,
        requires_open_auxiliary: input.requiresOpenAuxiliary ?? parent.requires_open_auxiliary,
        requires_item: input.requiresItem ?? parent.requires_item,
        requires_business_unit: input.requiresBusinessUnit ?? parent.requires_business_unit,
        statement_section: input.statementSection ?? parent.statement_section,
        ...defined(custom),
      })}
      returning id`);
    // The parent is now a heading: only leaves take movements (§4.1).
    await ctx.tx`update accounting.accounts set allows_movement = false where id = ${parent.id} and allows_movement`;
    return { id: inserted!.id };
  },
});

export const accountUpdate = defineProcess({
  id: "accounting.account.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Actualiza el nombre, las marcas de exigencia o el estado de una cuenta; el código no cambia",
  input: z.object({ id, name: name.optional(), nature: nature.optional(), ...flags, statementSection, isActive: z.boolean().optional(), extra, extraPatch, extraFree: extraFree.optional() }).strict(),
  output: idOutput,
  handler: async (ctx, { id: accountId, extraPatch: patch, ...input }) => {
    const [current] = await ctx.tx<{ extra: Record<string, unknown> }[]>`select extra from accounting.accounts where id = ${accountId} and company_id = ${ctx.companyId} for update`;
    if (!current) throw new ProcessError("not_found", `account ${accountId} not found`);
    if (input.isActive === false) {
      const [draft] = await ctx.tx<{ used: boolean }[]>`
        select exists (select 1 from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
                       where l.account_id = ${accountId} and e.status in ('draft', 'pending')) as used`;
      if (draft!.used) throw invalid(`account ${accountId} has draft lines`, "No se puede desactivar: hay comprobantes en borrador con líneas en esta cuenta");
    }
    const custom = await extraForUpdate(ctx, "accounting.account", "accounting.account.update", current.extra, { ...input, extraPatch: patch });
    const set = defined({
      name: input.name,
      nature: input.nature,
      requires_party: input.requiresParty,
      requires_invoice_ready: input.requiresInvoiceReady,
      requires_cost_center: input.requiresCostCenter,
      requires_open_auxiliary: input.requiresOpenAuxiliary,
      requires_item: input.requiresItem,
      requires_business_unit: input.requiresBusinessUnit,
      statement_section: input.statementSection,
      is_active: input.isActive,
      ...custom,
    });
    if (Object.keys(set).length > 0) await ctx.tx`update accounting.accounts set ${ctx.tx(set)} where id = ${accountId}`;
    return { id: accountId };
  },
});

export const accountConsult = defineProcess({
  id: "accounting.account.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta una cuenta del plan con los campos que el rol puede ver; las cuentas restringidas no se muestran a quien no las ve",
  input: z.object({ id }),
  output: rowOutput,
  handler: async (ctx, { id: accountId }) => {
    const [row] = await ctx.tx`select * from accounting.v_accounts where id = ${accountId}`;
    if (!row) throw new ProcessError("not_found", `account ${accountId} not found`);
    return { ...row, id: accountId, extra: await visibleExtra(ctx, "accounting.account", row.extra) };
  },
});

export const ACCOUNT_PROCESSES = [accountCreate, accountUpdate, accountConsult];
