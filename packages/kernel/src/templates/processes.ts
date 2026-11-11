import { z } from "zod";
import { ADMIN_FEATURE, invalid, requireAdmin } from "../admin/common";
import type { Tx } from "../db/client";
import { exportColumns, type ExportPresentation } from "../exports/columns";
import { asProcessError, presentationLabels, presentationValues } from "../exports/export.process";
import { CONTENT_TYPE, exportFileName } from "../exports/file";
import { exportRowsInTx, flatten, planExport } from "../exports/plan";
import { EXPORT_PDF_INLINE_LIMIT, type ExportRow } from "../exports/types";
import { exportsStore, fileStore } from "../files/store";
import { defineProcess } from "../process/define";
import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import { requireGridAccess } from "../query/access";
import { EXTRA_PREFIX, GridState } from "../query/grid-state";
import { addRefLabels } from "../query/ref-labels";
import { gridAccess } from "../query/run";
import type { ResolvedEntityDef } from "../registry/entities";
import { IDENTIFIER } from "../registry/fields";
import { countryPackOf, translatorFor, type Translate } from "../registry/labels";
import { defaultTemplate, printableFields, printLabels, type DefaultPresentation } from "./defaults";
import type { TableSource } from "./render";
import { DOC_TEMPLATE_ENTITY, MAX_PAGE_POINTS, TEMPLATE_SCOPES, TemplateBlocks, type Block, type Template, type TemplateScope } from "./schema";
import { IMAGE_VARIABLES, listVariables, loadPrintCompany, loadPrintUser, recordCurrency, resolveVariables, variableNames, type PrintContext } from "./variables";

// The PDF template processes (entity types spec 2026-11-02 §6; Phase 2A.5 Task 11, migration 0048):
//   - kernel.doc_template.save: a company admin creates or changes a template (step-up, audited); every save is a new version;
//   - kernel.doc_template.set_default: the template a record or a list of the entity prints with (or none: the built-in default);
//   - kernel.doc_template.print: prints a record (`recordId`) or a list (`gridState`) of a maestro or documento as the caller, and stores
//     the PDF as the caller's finished export job (bucket `exports`, signed download through /api/export/:jobId, rule 22).
// Printing reads what the grid would: the company entitled to the entity, a role of the caller allowed its consult (and its menu item
// not hidden, kernel.can_run_process), its masked view under the caller's claims (company RLS, record-level read, field visibility). A
// record the caller cannot read is refused as one that does not exist. Print is shared by every entity (every maestro and documento
// prints); save and set_default are company-admin settings.

export const DOC_TEMPLATE_FEATURE = "kernel.doc_templates";

const SCOPE = z.enum(TEMPLATE_SCOPES);
const PDF_MIME = "application/pdf";

/** The maestro or documento `entityId`, or `invalid_input` (unknown, or a lines / parametro / sistema / query entity). */
function typedEntityOf(ctx: ProcessContext, entityId: string): ResolvedEntityDef {
  const entity = ctx.registry.entities().find((e) => e.id === entityId);
  if (!entity) throw invalid(`unknown entity ${entityId}`, `La entidad ${entityId} no existe`);
  if (entity.kind === "query" || (entity.entityType !== "maestro" && entity.entityType !== "documento")) {
    throw invalid(`entity ${entityId} is ${entity.entityType ?? entity.kind}`, `La entidad ${entityId} no es un maestro ni un documento`);
  }
  for (const part of [entity.schema, entity.table]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
  return entity;
}

const linesEntityOf = (ctx: ProcessContext, entity: ResolvedEntityDef): ResolvedEntityDef | null => (entity.typed?.lines ? ctx.registry.entity(entity.typed.lines.entity) : null);

/** The field names a `field` block or a table column may name: the printable fields and any admin-defined value (`extra.<key>`). */
const fieldNamesOf = (entity: ResolvedEntityDef) => new Set(printableFields(entity).map((f) => f.name));
const namesField = (names: Set<string>, name: string) => names.has(name) || (name.startsWith(EXTRA_PREFIX) && IDENTIFIER.test(name.slice(EXTRA_PREFIX.length)));

/** Refuses the blocks that name what the entity and scope do not have (the editor shows the messages). */
/** The variables the entity's module adds to a record print (ModuleDef.printVariables), when it has any. */
function moduleVariablesOf(ctx: ProcessContext, entity: ResolvedEntityDef) {
  return ctx.registry.hasModule(entity.module) ? ctx.registry.module(entity.module).printVariables?.[entity.id] : undefined;
}

function checkBlocks(ctx: ProcessContext, entity: ResolvedEntityDef, scope: TemplateScope, blocks: readonly Block[]): void {
  const problems: string[] = [];
  const variables = variableNames(entity, scope);
  const added = scope === "record" ? moduleVariablesOf(ctx, entity) : undefined;
  for (const name of added?.names ?? []) variables.add(name);
  const images = new Set<string>([...IMAGE_VARIABLES, ...(added?.images ?? [])]);
  const fields = fieldNamesOf(entity);
  const lines = linesEntityOf(ctx, entity);
  const tableFields = scope === "list" ? fields : lines ? fieldNamesOf(lines) : null;
  blocks.forEach((block, i) => {
    const at = `Bloque ${i + 1}`;
    switch (block.kind) {
      case "variable":
        if (!variables.has(block.value ?? "")) problems.push(`${at}: la variable ${block.value ?? ""} no existe`);
        break;
      case "field":
        if (scope !== "record") problems.push(`${at}: un campo del registro solo va en la plantilla de un registro`);
        else if (!namesField(fields, block.value ?? "")) problems.push(`${at}: la entidad no tiene el campo ${block.value ?? ""}`);
        break;
      case "image":
        if (!images.has(block.value ?? "")) problems.push(`${at}: la imagen ${block.value ?? ""} no existe`);
        break;
      case "lines":
        if (!tableFields) problems.push(`${at}: la entidad no tiene líneas`);
        else for (const column of block.columns ?? []) if (!namesField(tableFields, column)) problems.push(`${at}: la tabla no tiene la columna ${column}`);
        break;
      case "text":
      case "page_number":
        break;
    }
  });
  if (problems.length > 0) throw new ProcessError("invalid_input", `template blocks of ${entity.id} name what it does not have`, { details: problems });
}

/** The bytes of a template's background PDF (a live attachment of the template), read in `tx`. */
async function backgroundOf(tx: Tx, attachmentId: string): Promise<Uint8Array | null> {
  const [row] = await tx<{ storage_path: string }[]>`
    select storage_path from kernel.attachments where id = ${attachmentId} and entity = ${DOC_TEMPLATE_ENTITY} and removed_at is null and mime_type = ${PDF_MIME}`;
  return row ? (await fileStore()).get(row.storage_path) : null;
}

interface TemplateRow {
  id: string;
  entity: string;
  scope: TemplateScope;
  name: string;
  version: number;
  is_default: boolean;
  background_file_id: string | null;
  blocks: Block[];
}

const asTemplate = (row: TemplateRow): Template => ({
  id: row.id,
  entity: row.entity,
  scope: row.scope,
  name: row.name,
  version: row.version,
  isDefault: row.is_default,
  backgroundFileId: row.background_file_id,
  blocks: TemplateBlocks.parse(row.blocks),
});

const templateInput = z.object({
  /** The template to change; absent to create one. */
  id: z.uuid().optional(),
  entity: z.string().min(1).max(100),
  scope: SCOPE,
  name: z.string().trim().min(1, "El nombre es obligatorio").max(120, "Máximo 120 caracteres"),
  blocks: TemplateBlocks,
  /** A PDF attached to this template (kernel.doc_template), or null for none. */
  backgroundFileId: z.uuid().nullable().optional(),
  /** The version the editor read: a template saved since then is refused `stale_record` (two admins never overwrite each other). */
  expectedVersion: z.number().int().min(1).optional(),
});

export const docTemplateSave = defineProcess({
  id: "kernel.doc_template.save",
  module: "kernel",
  kind: "update",
  recordAccess: "none",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description:
    "Crea o cambia una plantilla PDF de un maestro o documento (de un registro o de la lista): bloques de texto, variables, campos, tabla de líneas, imagen y número de página, sobre un PDF de fondo opcional; cada guardado es una versión nueva",
  input: templateInput,
  output: z.object({ id: z.string(), version: z.number().int() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const entity = typedEntityOf(ctx, input.entity);
    checkBlocks(ctx, entity, input.scope, input.blocks);

    let existing: TemplateRow | undefined;
    if (input.id) {
      // Locked: a concurrent save of the same template waits for this one, then sees its version.
      [existing] = await ctx.tx<TemplateRow[]>`select * from kernel.doc_templates where id = ${input.id} and company_id = ${ctx.companyId} for update`;
      if (!existing) throw new ProcessError("not_found", `template ${input.id} not found`);
      if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
        throw new ProcessError("stale_record", `template ${input.id} is at version ${existing.version}, not ${input.expectedVersion}`, {
          details: { expectedVersion: input.expectedVersion, version: existing.version },
        });
      }
      if (existing.entity !== entity.id || existing.scope !== input.scope) {
        throw invalid(`template ${input.id} is a ${existing.scope} template of ${existing.entity}`, "Una plantilla no cambia de entidad ni de alcance");
      }
    }
    const [clash] = await ctx.tx`
      select 1 from kernel.doc_templates
      where company_id = ${ctx.companyId} and entity = ${entity.id} and scope = ${input.scope} and name = ${input.name} and id is distinct from ${input.id ?? null}`;
    if (clash) throw invalid(`template name ${input.name} is taken`, `Ya existe una plantilla con el nombre ${input.name}`);

    const background = input.backgroundFileId === undefined ? (existing?.background_file_id ?? null) : input.backgroundFileId;
    if (background !== null && background !== existing?.background_file_id) {
      if (!input.id) throw invalid("a new template has no files yet", "Guarda la plantilla y luego adjunta su PDF de fondo");
      const [file] = await ctx.tx<{ storage_path: string; mime_type: string }[]>`
        select storage_path, mime_type from kernel.attachments
        where id = ${background} and company_id = ${ctx.companyId} and entity = ${DOC_TEMPLATE_ENTITY} and record_id = ${input.id} and removed_at is null`;
      if (!file || file.mime_type !== PDF_MIME) throw invalid(`attachment ${background} is not a PDF of the template`, "El fondo debe ser un PDF adjunto a esta plantilla");
      let pages: { width: number; height: number }[];
      try {
        // Loaded on demand, like the renderer: the PDF libraries are large and only templates need them.
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.load(await (await fileStore()).get(file.storage_path));
        pages = pdf.getPages().slice(0, 2).map((page) => page.getSize());
      } catch {
        throw invalid(`attachment ${background} is not a readable PDF`, "El PDF de fondo no se puede leer (¿está protegido o dañado?)");
      }
      // Its first page (and its second, under the continuation pages) is the page the blocks are placed on.
      if (pages.length === 0) throw invalid(`attachment ${background} has no pages`, "El PDF de fondo no tiene páginas");
      if (pages.some((page) => page.width > MAX_PAGE_POINTS || page.height > MAX_PAGE_POINTS)) {
        throw invalid(`attachment ${background} has a page beyond ${MAX_PAGE_POINTS} points`, `Las páginas del PDF de fondo miden como máximo ${MAX_PAGE_POINTS} puntos por lado`);
      }
    }

    const blocks = ctx.tx.json(input.blocks as never);
    if (existing) {
      // Every save is a new version (the trigger kernel.doc_templates_version keeps the count).
      const [row] = await ctx.tx<{ id: string; version: number }[]>`
        update kernel.doc_templates set name = ${input.name}, blocks = ${blocks}, background_file_id = ${background}, version = version + 1
        where id = ${existing.id}
        returning id, version`;
      return { id: row!.id, version: row!.version };
    }
    const [row] = await ctx.tx<{ id: string; version: number }[]>`
      insert into kernel.doc_templates (company_id, entity, scope, name, blocks, background_file_id)
      values (${ctx.companyId}, ${entity.id}, ${input.scope}, ${input.name}, ${blocks}, ${background})
      returning id, version`;
    return { id: row!.id, version: row!.version };
  },
});

export const docTemplateSetDefault = defineProcess({
  id: "kernel.doc_template.set_default",
  module: "kernel",
  kind: "update",
  recordAccess: "none",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description:
    "Elige la plantilla PDF con la que se imprimen los registros (o la lista) de un maestro o documento; sin plantilla se usa la predeterminada del sistema",
  input: z.object({ entity: z.string().min(1).max(100), scope: SCOPE, id: z.uuid().nullable() }),
  output: z.object({ entity: z.string(), scope: z.string(), id: z.string().nullable() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const entity = typedEntityOf(ctx, input.entity);
    if (input.id) {
      const [row] = await ctx.tx`select 1 from kernel.doc_templates where id = ${input.id} and company_id = ${ctx.companyId} and entity = ${entity.id} and scope = ${input.scope}`;
      if (!row) throw new ProcessError("not_found", `template ${input.id} not found`);
    }
    await ctx.tx`
      update kernel.doc_templates set is_default = false
      where company_id = ${ctx.companyId} and entity = ${entity.id} and scope = ${input.scope} and is_default and id is distinct from ${input.id}`;
    if (input.id) await ctx.tx`update kernel.doc_templates set is_default = true where id = ${input.id} and not is_default`;
    return { entity: entity.id, scope: input.scope, id: input.id };
  },
});

const printInput = z.object({
  entity: z.string().min(1).max(100),
  /** The record to print (its record template); absent, the list of `gridState` (its list template). */
  recordId: z.uuid().optional(),
  /** The grid's state: its filters, sort and visible columns (every page). Ignored with `recordId`. */
  gridState: GridState.optional(),
  /** A template of the entity and scope; absent, the company's default, else the built-in one. */
  templateId: z.uuid().optional(),
  /** The title of the built-in template and of the file name (the screen's name of the entity). */
  title: z.string().trim().min(1).max(120).optional(),
  /** Header by field, as the caller's screen shows it (the record's fields and its lines' columns); cosmetic, never widens access. */
  labels: presentationLabels.optional(),
  /** Value labels by field (enums, codes). */
  values: presentationValues.optional(),
  /** The page number's words in the caller's language (`{n}`, `{total}`); absent, the app's catalogue (`common.print.page_number`). */
  pageText: z.string().trim().min(1).max(120).optional(),
});
export type PrintInput = z.infer<typeof printInput>;

/** What a print renders: the PDF and what it was made from (the e-mails of Task 12 attach it without storing it). */
export interface PrintedDocument {
  pdf: Buffer;
  template: Template;
  scope: TemplateScope;
  fileName: string;
  rowCount: number;
}

/** The template a print uses: the one asked for (of the entity and scope), else the company's default, else the built-in one. */
async function templateFor(ctx: ProcessContext, entity: ResolvedEntityDef, scope: TemplateScope, templateId: string | undefined, presentation: ExportPresentation & { title?: string; taxIdLabel?: string }): Promise<Template> {
  if (templateId) {
    const [row] = await ctx.tx<TemplateRow[]>`select * from kernel.doc_templates where id = ${templateId} and company_id = ${ctx.companyId}`;
    if (!row) throw new ProcessError("not_found", `template ${templateId} not found`);
    if (row.entity !== entity.id || row.scope !== scope) {
      throw invalid(`template ${templateId} is a ${row.scope} template of ${row.entity}`, "La plantilla es de otra entidad o de otro alcance");
    }
    return asTemplate(row);
  }
  const [row] = await ctx.tx<TemplateRow[]>`
    select * from kernel.doc_templates where company_id = ${ctx.companyId} and entity = ${entity.id} and scope = ${scope} and is_default`;
  if (row) return asTemplate(row);
  const builtIn: DefaultPresentation = {
    ...(presentation.labels ? { labels: presentation.labels } : {}),
    ...(presentation.title ? { title: presentation.title } : {}),
    ...(presentation.taxIdLabel ? { taxIdLabel: presentation.taxIdLabel } : {}),
    t: translatorFor(ctx.locale),
  };
  // The template the entity's module ships (ModuleDef.printTemplates), else the one generated from its fields.
  const shipped = ctx.registry.hasModule(entity.module) ? ctx.registry.module(entity.module).printTemplates?.[entity.id]?.[scope] : undefined;
  if (!shipped) return defaultTemplate(entity, scope, builtIn);
  const template = shipped(builtIn);
  checkBlocks(ctx, entity, scope, template.blocks);
  return { ...template, id: null, entity: entity.id, scope, version: 0, isDefault: true };
}

/** The rows of `entity`'s view `where` (as the caller), keyed by the caller's columns, references named. */
async function readRows(ctx: ProcessContext, entity: ResolvedEntityDef, presentation: ExportPresentation, where: string, params: unknown[], limit: number) {
  const access = await gridAccess(ctx.tx, entity);
  const columns = exportColumns(entity, access, {}, presentation, translatorFor(ctx.locale));
  const order = entity.fields.some((f) => f.name === entity.defaultSort.field) && IDENTIFIER.test(entity.defaultSort.field) ? ` order by "${entity.defaultSort.field}" ${entity.defaultSort.dir === "desc" ? "desc" : "asc"}, id` : " order by id";
  const raw = await ctx.tx.unsafe<Record<string, unknown>[]>(`select * from ${entity.schema}.v_${entity.table} where ${where}${order} limit ${limit}`, params as never[]);
  await addRefLabels(ctx.tx, ctx.registry, entity, raw);
  const refs = new Set(entity.fields.filter((f) => f.type === "ref").map((f) => f.name));
  return { access, columns, rows: raw.map((row): ExportRow => flatten(row, columns, [], refs)) };
}

/**
 * Renders the print of `input` as the caller, in the run's transaction (see the file comment). Throws `invalid_input` (an entity that
 * is not a maestro or documento, a template of another entity or scope, a list beyond the PDF limit), `not_found` (the record, or the
 * template), `forbidden` / `not_entitled` as the grid would, and the grid's refusals of the state (a masked or hidden field filtered).
 * The copy it prints (field labels the caller did not give, the page number's words, the tax id's label) comes from `t`: the app's
 * catalogue in the caller's language by default (`registerCatalogue`), the country pack for the tax id's name (rule 5, rule 24).
 * `opts.printedAt` fixes the print's instant (see below).
 */
export async function renderPrint(ctx: ProcessContext, input: PrintInput, t: Translate = translatorFor(ctx.locale), opts: { printedAt?: Date } = {}): Promise<PrintedDocument> {
  // The print's instant: the date it prints, the file name's day and the PDF's own dates. A state e-mail passes its event's, so a
  // retry renders the same bytes (Task 12); a screen's print is now.
  const printedAt = opts.printedAt ?? new Date();
  const entity = typedEntityOf(ctx, input.entity);
  const scope: TemplateScope = input.recordId ? "record" : "list";
  const lines = linesEntityOf(ctx, entity);
  await requireGridAccess(ctx.tx, ctx.registry, entity);
  const company = await loadPrintCompany(ctx.tx);
  // Labels: the screen's, else the registry's keys in the catalogue (never the raw field name while the catalogue has them).
  const labels = printLabels(lines && scope === "record" ? [entity, lines] : [entity], t, input.labels ?? {});
  const taxIdLabel = countryPackOf(company.country)?.taxIdLabel?.(ctx.locale) ?? t("common.print.tax_id");
  const presentation: ExportPresentation & { title?: string; taxIdLabel?: string } = {
    labels,
    ...(input.values ? { values: input.values } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(taxIdLabel ? { taxIdLabel } : {}),
  };
  const template = await templateFor(ctx, entity, scope, input.templateId, presentation);
  const user = await loadPrintUser(ctx.tx, ctx.userId);
  const base = { company, user, printedAt, locale: ctx.locale, timeZone: company.timeZone };

  let vars: Record<string, string>;
  let table: TableSource | undefined;
  let rowCount: number;
  let currency: string | undefined;
  if (input.recordId) {
    const record = await readRows(ctx, entity, presentation, "id = $1", [input.recordId], 1);
    // Not there, or not readable by the caller (company RLS, record-level read): the same refusal, so it never tells which.
    if (record.rows.length === 0) throw new ProcessError("not_found", `${entity.id} ${input.recordId} not found`);
    const ctxOf: PrintContext = { ...base, columns: record.columns };
    vars = resolveVariables(ctxOf, entity, record.rows[0]!);
    currency = recordCurrency(record.rows[0]!);
    // What the entity's module adds to the record's print (ModuleDef.printVariables: Task 19, the invoice's QR and CUFE), as the caller.
    const added = moduleVariablesOf(ctx, entity);
    if (added) {
      const values = await added.resolve(ctx, input.recordId, { locale: ctx.locale, printedAt });
      for (const name of [...added.names, ...(added.images ?? [])]) vars[name] = values[name] ?? "";
    }
    if (lines) {
      const parent = entity.typed!.lines!.parentField;
      if (!IDENTIFIER.test(parent)) throw new Error(`entity ${entity.id}: invalid lines parent field "${parent}"`);
      // One more than the limit: a document is printed whole or not at all (a part of its lines would print a wrong total).
      const read = await readRows(ctx, lines, presentation, `"${parent}" = $1`, [input.recordId], EXPORT_PDF_INLINE_LIMIT + 1);
      if (read.rows.length > EXPORT_PDF_INLINE_LIMIT) {
        throw new ProcessError("invalid_input", `a printed record takes up to ${EXPORT_PDF_INLINE_LIMIT} lines, ${entity.id} ${input.recordId} has more`, { details: ["pdf_too_large"] });
      }
      // The parent reference is the record itself: not a column of its own table.
      table = { columns: read.columns.filter((c) => c.field !== parent), rows: read.rows };
    }
    rowCount = 1;
  } else {
    // The list: the grid's own plan (its filters, sort and columns over the masked view, as the caller), every page; no grouping.
    const state = GridState.parse({ ...(input.gridState ?? { filters: [], sort: [], page: 1, pageSize: 50 }), groupBy: undefined, aggregates: undefined });
    const plan = await planExport(ctx.tx, ctx.registry, { entity: entity.id, format: "pdf", state, ...presentation }, ctx.locale).catch((error: unknown) => {
      throw asProcessError(error);
    });
    // A print is laid out in the request, in memory: up to the inline limit of the grid's PDF export (beyond it, that export's job).
    if (plan.total > EXPORT_PDF_INLINE_LIMIT) {
      throw new ProcessError("invalid_input", `a printed list takes up to ${EXPORT_PDF_INLINE_LIMIT} rows, this one has ${plan.total}`, { details: ["pdf_too_large"] });
    }
    const rows = await exportRowsInTx(ctx.tx, plan, EXPORT_PDF_INLINE_LIMIT);
    vars = listVariables({ ...base, columns: plan.columns }, entity, rows);
    table = { columns: plan.columns, rows };
    rowCount = rows.length;
  }

  const background = template.backgroundFileId ? await backgroundOf(ctx.tx, template.backgroundFileId) : null;
  // Loaded on demand (exports/render.ts does the same): the PDF engine is large and only a print needs it.
  const { renderTemplatePdf } = await import("./render");
  const pageText = input.pageText ?? t("common.print.page_number");
  const pdf = await renderTemplatePdf(template, vars, table, background ?? undefined, { locale: ctx.locale, timeZone: company.timeZone, printedAt, ...(pageText ? { pageText } : {}), ...(currency ? { currency } : {}) });
  const fileName = exportFileName(input.title ?? template.name, entity.id, "pdf", company.timeZone, printedAt);
  return { pdf, template, scope, fileName, rowCount };
}

export const docTemplatePrint = defineProcess({
  id: "kernel.doc_template.print",
  module: "kernel",
  kind: "consult",
  feature: DOC_TEMPLATE_FEATURE,
  description:
    "Imprime en PDF un registro (con su plantilla de registro) o la lista de un grid (con sus filtros, orden y columnas visibles) de un maestro o documento, con la plantilla de la empresa o la predeterminada; los campos que el usuario no ve salen vacíos",
  input: printInput,
  output: z.object({ fileId: z.string() }),
  // The audit says what was printed, not the screen's headers and value lists.
  auditInput: (input) => ({ entity: input.entity, recordId: input.recordId, gridState: input.gridState, templateId: input.templateId }),
  handler: async (ctx, input) => {
    const printed = await renderPrint(ctx, input);
    // Stored as the caller's finished export job: only they (and company admins) see it, downloaded by a signed link (rule 22).
    const [job] = await ctx.tx<{ id: string }[]>`select kernel.uuid_v7() as id`;
    const id = job!.id;
    const path = `${ctx.companyId}/${id}.pdf`;
    const request = { templateId: printed.template.id, templateVersion: printed.template.version, scope: printed.scope, recordId: input.recordId ?? null, gridState: input.gridState ?? null };
    await ctx.tx`
      insert into kernel.export_jobs (id, company_id, user_id, entity, format, state, status, storage_path, file_name, row_count, finished_at)
      values (${id}, ${ctx.companyId}, ${ctx.userId}, ${input.entity}, 'pdf', ${ctx.tx.json(request as never)}, 'done', ${path}, ${printed.fileName}, ${printed.rowCount}, now())`;
    // A dry run stores nothing outside the database (its row is rolled back with it).
    if (!ctx.dryRun) await (await exportsStore()).put(path, printed.pdf, CONTENT_TYPE.pdf);
    return { fileId: id };
  },
});

export const DOC_TEMPLATE_PROCESSES = [docTemplateSave, docTemplateSetDefault, docTemplatePrint];
/** The admin processes among them (feature kernel.admin, step-up). */
export const DOC_TEMPLATE_ADMIN_PROCESSES = [docTemplateSave, docTemplateSetDefault];
