import { defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { entityDef } from "../entities";
import { defined, invalid, refuseDuplicate } from "./common";
import { createDraft, entryInput } from "./entry";
import { assertTemplateValues } from "./template-values";
import { assertValid, validateLines, type LineInput } from "./entry-validate";
import { extraForCreate, extraForUpdate } from "./extra";
import { assertRefsExist, assertWritable, followLifecycle, initialLifecycle, lifecycleProcesses } from "./lifecycle";
import { extra, extraFree, extraPatch, id, idOutput, name, rowOutput } from "./schemas";

// Plantillas de comprobante (accounting design §4.10): recurring manual entries kept as a name, a Fuente and lines with a
// side and an optional fixed amount. `entry.from_template` turns one into a draft.

const optionalId = z.uuid().nullish();
/** One name per company (D14: the import key), 0043. */
const NAME_KEY = "entry_templates_company_id_name_key";
const duplicateName = (name: unknown) => `Ya existe una plantilla con el nombre ${String(name ?? "")}`;
/** The columns entry_template.update writes (its lines are replaced by the update process, not by Grabar). */
const WRITABLE = new Set(["name", "journal_id", "description", "business_unit_id", "values_editable", "note", "is_active", "extra", "extra_free"]);
const amount = z.number().min(0).max(9_999_999_999_999);

const templateLine = z
  .object({
    accountId: z.uuid().optional(),
    accountCode: z.string().trim().regex(/^\d+$/, "El código de la cuenta solo lleva dígitos").optional(),
    partyId: optionalId,
    costCenterId: optionalId,
    openAuxiliaryId: optionalId,
    itemId: optionalId,
    businessUnitId: optionalId,
    side: z.enum(["debit", "credit"]),
    amount: amount.nullish(),
    description: z.string().trim().max(500).nullish(),
  })
  .strict()
  .refine((line) => !!line.accountId || !!line.accountCode, { message: "Cada línea indica su cuenta (accountId o accountCode)" });
type TemplateLine = z.infer<typeof templateLine>;

/** The line as the entry validation sees it: only the side matters, so a unit amount stands in for the real one. */
const asProbe = (line: TemplateLine): LineInput => ({
  accountId: line.accountId, accountCode: line.accountCode, partyId: line.partyId, costCenterId: line.costCenterId,
  openAuxiliaryId: line.openAuxiliaryId, itemId: line.itemId, businessUnitId: line.businessUnitId,
  debit: line.side === "debit" ? 1 : 0, credit: line.side === "credit" ? 1 : 0,
});

async function validateTemplate(ctx: ProcessContext, journalId: string, businessUnitId: string | null | undefined, lines: readonly TemplateLine[]): Promise<void> {
  assertValid(await validateLines(ctx, { journalId, date: new Date().toISOString().slice(0, 10), businessUnitId, origin: "template" }, lines.map(asProbe), "draft"));
}

async function insertTemplateLines(ctx: ProcessContext, templateId: string, lines: readonly TemplateLine[]): Promise<void> {
  if (lines.length === 0) return;
  const codes = [...new Set(lines.map((l) => l.accountCode).filter((v): v is string => !!v))];
  const ids = [...new Set(lines.map((l) => l.accountId).filter((v): v is string => !!v))];
  const accounts = await ctx.tx<{ id: string; code: string }[]>`
    select id, code from accounting.accounts where company_id = ${ctx.companyId} and (id = any(${ids}::uuid[]) or code = any(${codes}::text[]))`;
  const idOf = (line: TemplateLine) => line.accountId ?? accounts.find((a) => a.code === line.accountCode)!.id;
  await ctx.tx`insert into accounting.entry_template_lines ${ctx.tx(
    lines.map((line, index) => ({
      company_id: ctx.companyId, template_id: templateId, line_no: index + 1, account_id: idOf(line), party_id: line.partyId ?? null,
      cost_center_id: line.costCenterId ?? null, open_auxiliary_id: line.openAuxiliaryId ?? null, item_id: line.itemId ?? null,
      business_unit_id: line.businessUnitId ?? null, side: line.side, amount: line.amount ?? null, description: line.description ?? null,
    })),
  )}`;
}

/** The stored lines of a plantilla, as templateLine reads them. */
async function storedLines(ctx: ProcessContext, templateId: string): Promise<TemplateLine[]> {
  const rows = await ctx.tx<{ account_id: string; party_id: string | null; cost_center_id: string | null; open_auxiliary_id: string | null; item_id: string | null; business_unit_id: string | null; side: "debit" | "credit" }[]>`
    select account_id, party_id, cost_center_id, open_auxiliary_id, item_id, business_unit_id, side
    from accounting.entry_template_lines where template_id = ${templateId} order by line_no`;
  return rows.map((r) => ({
    accountId: r.account_id, partyId: r.party_id, costCenterId: r.cost_center_id, openAuxiliaryId: r.open_auxiliary_id, itemId: r.item_id,
    businessUnitId: r.business_unit_id, side: r.side,
  }));
}

/** The plantilla's lifecycle hook: Grabar writes only the update process's header columns and validates the Fuente and lines again. */
export const templateHooks: TypedHooks = {
  async validate(ctx, record, mode, change) {
    if (mode !== "save") return;
    assertWritable("accounting.entry_template.save", change.data, WRITABLE);
    if (typeof record.name !== "string" || record.name.trim() === "") throw invalid("template name is empty", "La plantilla lleva un nombre");
    if (record.journal_id !== change.previous.journal_id || record.business_unit_id !== change.previous.business_unit_id) {
      await validateTemplate(ctx, String(record.journal_id), record.business_unit_id as string | null, await storedLines(ctx, record.id));
    }
  },
};

const headerShape = {
  name,
  journalId: z.uuid(),
  description: z.string().trim().max(500).nullish(),
  businessUnitId: optionalId,
  /** The user of the plantilla may change its fixed amounts. */
  valuesEditable: z.boolean().default(true),
  note: z.string().trim().max(2000).nullish(),
  lines: z.array(templateLine).min(1).max(200),
};

export const templateCreate = defineProcess({
  id: "accounting.entry_template.create",
  module: "accounting",
  kind: "create",
  feature: "accounting.ledger",
  description: "Crea una plantilla de comprobante recurrente (arriendo, provisiones) con sus líneas",
  input: z.object({ ...headerShape, extra, extraFree: extraFree.optional() }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    await validateTemplate(ctx, input.journalId, input.businessUnitId, input.lines);
    const custom = await extraForCreate(ctx, "accounting.entry_template", "accounting.entry_template.create", input);
    const lifecycle = await initialLifecycle(ctx, "accounting.entry_template");
    const [inserted] = await refuseDuplicate("accounting.entry_template.create", NAME_KEY, duplicateName(input.name), () => ctx.tx<{ id: string }[]>`
      insert into accounting.entry_templates ${ctx.tx({
        company_id: ctx.companyId, name: input.name, journal_id: input.journalId, description: input.description ?? null,
        business_unit_id: input.businessUnitId ?? null, values_editable: input.valuesEditable, note: input.note ?? null, ...defined(custom), ...lifecycle,
      })}
      returning id`);
    await insertTemplateLines(ctx, inserted!.id, input.lines);
    return { id: inserted!.id };
  },
});

export const templateUpdate = defineProcess({
  id: "accounting.entry_template.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.ledger",
  description: "Actualiza una plantilla de comprobante; si se envían las líneas, reemplazan a las anteriores",
  input: z
    .object({ id, name: name.optional(), journalId: z.uuid().optional(), description: z.string().trim().max(500).nullish(), businessUnitId: optionalId, valuesEditable: z.boolean().optional(), note: z.string().trim().max(2000).nullish(), lines: headerShape.lines.optional(), isActive: z.boolean().optional(), extra, extraPatch, extraFree: extraFree.optional() })
    .strict(),
  output: idOutput,
  handler: async (ctx, { id: templateId, extraPatch: patch, lines, ...input }) => {
    const [current] = await ctx.tx<{ journal_id: string; business_unit_id: string | null; extra: Record<string, unknown> }[]>`
      select * from accounting.entry_templates where id = ${templateId} and company_id = ${ctx.companyId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `template ${templateId} not found`);
    const journalId = input.journalId ?? current.journal_id;
    const businessUnitId = input.businessUnitId === undefined ? current.business_unit_id : input.businessUnitId;
    if (lines || input.journalId !== undefined || input.businessUnitId !== undefined) {
      await validateTemplate(ctx, journalId, businessUnitId, lines ?? (await storedLines(ctx, templateId)));
    }
    const custom = await extraForUpdate(ctx, "accounting.entry_template", "accounting.entry_template.update", current.extra, { ...input, extraPatch: patch });
    const set = defined({
      name: input.name, journal_id: input.journalId, description: input.description, business_unit_id: input.businessUnitId, values_editable: input.valuesEditable, note: input.note, is_active: input.isActive, ...custom,
    });
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("accounting.entry_template.update", NAME_KEY, duplicateName(input.name), () => ctx.tx`update accounting.entry_templates set ${ctx.tx(set)} where id = ${templateId}`);
    }
    if (lines) {
      await ctx.tx`delete from accounting.entry_template_lines where template_id = ${templateId}`;
      await insertTemplateLines(ctx, templateId, lines);
    }
    await followLifecycle(ctx, "accounting.entry_template", templateId, current);
    return { id: templateId };
  },
});

type TemplateRow = Record<string, unknown> & { extra: Record<string, unknown> };

async function templateOf(ctx: ProcessContext, templateId: string) {
  const [row] = await ctx.tx<TemplateRow[]>`select * from accounting.v_entry_templates where id = ${templateId}`;
  if (!row) throw new ProcessError("not_found", `template ${templateId} not found`);
  const lines = await ctx.tx<(Record<string, unknown> & { line_no: number })[]>`
    select l.*, a.code as account_code, a.name as account_name
    from accounting.v_entry_template_lines l left join accounting.v_accounts a on a.id = l.account_id
    where l.template_id = ${templateId} order by l.line_no`;
  return { row, lines };
}

export const templateConsult = defineProcess({
  id: "accounting.entry_template.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Consulta una plantilla de comprobante con sus líneas",
  input: z.object({ id }),
  output: rowOutput,
  handler: async (ctx, { id: templateId }) => {
    const { row, lines } = await templateOf(ctx, templateId);
    return { ...row, id: templateId, extra: await visibleExtra(ctx, "accounting.entry_template", row.extra), lines };
  },
});

export const entryFromTemplate = defineProcess({
  id: "accounting.entry.from_template",
  module: "accounting",
  kind: "create",
  recordAccess: { entity: "accounting.entry_template", idField: "templateId", right: "use" },
  feature: "accounting.ledger",
  description: "Crea un borrador de comprobante a partir de una plantilla, con los valores indicados por línea",
  input: z
    .object({
      templateId: z.uuid(),
      date: z.iso.date(),
      /** Amount per template line number, overriding the template's fixed amount. */
      amounts: z.record(z.string().regex(/^\d+$/), amount).optional(),
      description: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const { row, lines } = await templateOf(ctx, input.templateId);
    // A plantilla is a maestro (Task 8b): only an active one, Grabado (or Aprobado when it requires approval), makes comprobantes.
    const [usable] = await ctx.tx<{ ok: boolean }[]>`select kernel.record_usable('accounting.entry_template', ${input.templateId}::uuid) as ok`;
    if (!usable?.ok) throw invalid(`template ${input.templateId} is not usable`, "La plantilla está inactiva o pendiente de aprobación");
    const missing: string[] = [];
    const entryLines = lines.map((line) => {
      const given = input.amounts?.[String(line.line_no)];
      const value = given ?? (line.amount === null || line.amount === undefined ? undefined : Number(line.amount));
      if (!value || value <= 0) missing.push(`Falta el valor de la línea ${line.line_no}${line.account_code ? ` (${line.account_code})` : ""}`);
      const side = line.side as "debit" | "credit";
      return {
        accountId: line.account_id as string, partyId: line.party_id as string | null, costCenterId: line.cost_center_id as string | null,
        openAuxiliaryId: line.open_auxiliary_id as string | null, itemId: line.item_id as string | null,
        businessUnitId: line.business_unit_id as string | null, description: line.description as string | null,
        debit: side === "debit" ? value ?? 0 : 0, credit: side === "credit" ? value ?? 0 : 0,
      };
    });
    if (lines.length === 0) throw invalid(`template ${input.templateId} has no lines`, "La plantilla no tiene líneas");
    if (missing.length > 0) throw new ProcessError("invalid_input", "the template needs amounts", { details: missing });
    const parsed = entryInput.parse({
      journalId: row.journal_id, date: input.date, description: input.description ?? (row.description as string | null) ?? (row.name as string),
      businessUnitId: row.business_unit_id, lines: entryLines,
    });
    await assertTemplateValues(ctx, input.templateId, parsed.lines);
    return { id: await createDraft(ctx, parsed, "template", { template_id: input.templateId }) };
  },
});

export const TEMPLATE_PROCESSES = [
  templateCreate, templateUpdate, templateConsult, entryFromTemplate,
  ...lifecycleProcesses(entityDef("accounting.entry_template"), "accounting.ledger", {
    writable: WRITABLE,
    before: {
      save: (ctx, input) => assertRefsExist(ctx, input.data, {
        journal_id: { table: "accounting.journals", noun: "la fuente" }, business_unit_id: { table: "accounting.business_units", noun: "la unidad de negocio" },
      }),
    },
    duplicate: { constraint: NAME_KEY, detail: (data) => duplicateName(data.name) },
  }),
];
