import { defineProcess, ProcessError } from "@erp/kernel";
import { z } from "zod";
import { DIMENSION_DEFS, type Dimension } from "../dimensions";
import { invalid, settingsOf } from "./common";
import { createDraft, entryInput } from "./entry";
import { postEntry } from "./entry-post";
import { id, idOutput } from "./schemas";

// Opening balances (accounting design §5.8): a draft in the Apertura journal made from codes and documents, and the human step
// that posts it under step-up. The import framework of phase 2b calls `opening.create` per file.

const amount = z.number().min(0).max(9_999_999_999_999);
const code = z.string().trim().min(1).max(30);

const openingLine = z
  .object({
    accountCode: z.string().trim().regex(/^\d+$/, "El código de la cuenta solo lleva dígitos"),
    partyDocument: z.string().trim().min(1).max(30).optional(),
    costCenterCode: code.optional(),
    openAuxiliaryCode: code.optional(),
    itemCode: code.optional(),
    businessUnitCode: code.optional(),
    debit: amount.default(0),
    credit: amount.default(0),
    description: z.string().trim().max(500).optional(),
    reference: z.string().trim().max(120).optional(),
    dueDate: z.iso.date().optional(),
  })
  .strict()
  .refine((line) => (line.debit > 0) !== (line.credit > 0), { message: "Cada línea lleva un valor en débito o en crédito, no en ambos ni en ninguno" });

export const openingCreate = defineProcess({
  id: "accounting.opening.create",
  module: "accounting",
  kind: "create",
  recordAccess: "none",
  feature: "accounting.ledger",
  description: "Crea el borrador de saldos iniciales en la fuente de apertura a partir de códigos de cuenta, documentos de terceros y códigos analíticos",
  input: z.object({ date: z.iso.date().optional(), description: z.string().trim().min(1).max(500).optional(), lines: z.array(openingLine).min(1).max(5000) }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const settings = await settingsOf(ctx);
    if (!settings) throw invalid("accounting is not configured", "Configura la contabilidad (siembra el plan de cuentas) antes de cargar saldos iniciales");
    const [journal] = await ctx.tx<{ id: string }[]>`
      select id from accounting.journals where company_id = ${ctx.companyId} and kind = 'opening' and is_active order by code limit 1`;
    if (!journal) throw invalid("no opening journal", "No hay una fuente de apertura activa");

    const problems: string[] = [];
    const documents = [...new Set(input.lines.map((l) => l.partyDocument).filter((v): v is string => !!v))];
    const parties = documents.length === 0 ? [] : await ctx.tx<{ id: string; document_number: string }[]>`
      select id, document_number from core.v_parties where company_id = ${ctx.companyId} and document_number = any(${documents}::text[])`;
    const partyOf = new Map(parties.map((p) => [p.document_number, p.id]));
    for (const document of documents) if (!partyOf.has(document)) problems.push(`No existe un tercero con el documento ${document}`);

    const nodeIds: Record<Dimension, Map<string, string>> = { cost_center: new Map(), open_auxiliary: new Map(), item: new Map(), business_unit: new Map() };
    const given: Record<Dimension, keyof z.infer<typeof openingLine>> = {
      cost_center: "costCenterCode", open_auxiliary: "openAuxiliaryCode", item: "itemCode", business_unit: "businessUnitCode",
    };
    for (const dimension of Object.keys(given) as Dimension[]) {
      const codes = [...new Set(input.lines.map((l) => l[given[dimension]] as string | undefined).filter((v): v is string => !!v))];
      if (codes.length === 0) continue;
      const def = DIMENSION_DEFS[dimension];
      const nodes = await ctx.tx<{ id: string; code: string }[]>`select id, code from ${ctx.tx(`accounting.${def.table}`)} where company_id = ${ctx.companyId} and code = any(${codes}::text[])`;
      for (const node of nodes) nodeIds[dimension].set(node.code, node.id);
      for (const c of codes) if (!nodeIds[dimension].has(c)) problems.push(`No existe el ${def.noun} con código ${c}`);
    }
    if (problems.length > 0) throw new ProcessError("invalid_input", "the opening lines name records that do not exist", { details: problems });

    const date = input.date ?? settings.ledgerStartsOn ?? new Date().toISOString().slice(0, 10);
    const parsed = entryInput.parse({
      journalId: journal.id, date, description: input.description ?? "Saldos iniciales",
      lines: input.lines.map((l) => ({
        accountCode: l.accountCode, partyId: l.partyDocument ? partyOf.get(l.partyDocument) : undefined,
        costCenterId: l.costCenterCode ? nodeIds.cost_center.get(l.costCenterCode) : undefined,
        openAuxiliaryId: l.openAuxiliaryCode ? nodeIds.open_auxiliary.get(l.openAuxiliaryCode) : undefined,
        itemId: l.itemCode ? nodeIds.item.get(l.itemCode) : undefined,
        businessUnitId: l.businessUnitCode ? nodeIds.business_unit.get(l.businessUnitCode) : undefined,
        debit: l.debit, credit: l.credit, description: l.description, reference: l.reference, dueDate: l.dueDate,
      })),
    });
    // Saldos iniciales post only through opening.post (step-up): never through approval.
    return { id: await createDraft(ctx, parsed, "import", { is_opening: true, requires_approval: false }) };
  },
});

export const openingPost = defineProcess({
  id: "accounting.opening.post",
  module: "accounting",
  kind: "update",
  recordAccess: { entity: "accounting.entry", idField: "id", right: "modify" },
  feature: "accounting.ledger",
  sensitivity: "step-up",
  description: "Contabiliza el comprobante de saldos iniciales; es el paso humano que exige la regla, con verificación TOTP",
  emits: ["accounting.entry.posted"],
  input: z.object({ id }).strict(),
  output: z.object({ id: z.string(), number: z.string() }),
  handler: async (ctx, { id: entryId }) => {
    const [entry] = await ctx.tx<{ is_opening: boolean }[]>`select is_opening from accounting.entries where id = ${entryId} and company_id = ${ctx.companyId}`;
    if (!entry) throw new ProcessError("not_found", `entry ${entryId} not found`);
    if (!entry.is_opening) throw invalid(`entry ${entryId} is not an opening entry`, "Este comprobante no es de saldos iniciales: contabilízalo con Grabar (entry.save)");
    const posted = await postEntry(ctx, entryId);
    return { id: posted.id, number: posted.number };
  },
});

export const OPENING_PROCESSES = [openingCreate, openingPost];
