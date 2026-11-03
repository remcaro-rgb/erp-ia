import { z } from "zod";
import { defineEntity } from "../registry/entities";

// PDF templates (entity types spec 2026-11-02 §6, design §11, §22.23; Phase 2A.5 Task 11): what a template is made of. A template prints
// one record (`record`) or a list of records (`list`) of a maestro or documento, as blocks placed on the page, optionally over a
// background PDF (the company's letterhead: its first page under the first page, its second page, when it has one, under the
// continuation pages). Coordinates are PDF points (1/72 in) from the top-left corner of the page. Dependency-free (zod only) so the
// template editor validates with the same schema the server stores.

export const BLOCK_KINDS = ["text", "variable", "field", "lines", "image", "page_number"] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const TEMPLATE_SCOPES = ["record", "list"] as const;
export type TemplateScope = (typeof TEMPLATE_SCOPES)[number];

/** The longest page side a block may reach, in points (A3 is 1191). */
export const MAX_PAGE_POINTS = 1700;
/** Blocks per template. */
export const MAX_BLOCKS = 200;

const coordinate = z.number().finite().min(0).max(MAX_PAGE_POINTS);
const extent = z.number().finite().positive().max(MAX_PAGE_POINTS);

/**
 * One block of a template:
 *   - `text`: the fixed text `value`;
 *   - `variable`: the system variable named by `value` (`empresa.nit`, `usuario.nombre`, `fecha_impresion`, `registros`, `total.<field>`);
 *   - `field`: the record's field named by `value` (`legal_name`, `extra.<key>`), as the printing user sees it;
 *   - `lines`: a table: the record's lines (record scope) or the list's rows (list scope), `columns` in that order (all when absent);
 *   - `image`: the image variable named by `value` (`empresa.logo`);
 *   - `page_number`: `Página n de m`, or `value` with `{n}` and `{total}`.
 */
export const Block = z
  .object({
    kind: z.enum(BLOCK_KINDS),
    x: coordinate,
    y: coordinate,
    w: extent,
    h: extent.optional(),
    font: z.object({ size: z.number().finite().min(4).max(72), bold: z.boolean().optional() }).strict().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    value: z.string().max(2000).optional(),
    columns: z.array(z.string().min(1).max(80)).max(30).optional(),
  })
  .strict();
export type Block = z.infer<typeof Block>;

export const TemplateBlocks = z.array(Block).max(MAX_BLOCKS, `Máximo ${MAX_BLOCKS} bloques por plantilla`);

/** A template as the renderer reads it: a stored one (`id`), or the built-in default of the entity (`id: null`, version 0). */
export interface Template {
  id: string | null;
  entity: string;
  scope: TemplateScope;
  name: string;
  /** 1 on the first save, one more on every save; 0 for the built-in default. */
  version: number;
  isDefault: boolean;
  /** A PDF attachment of the template (kernel.attachments, entity `kernel.doc_template`). */
  backgroundFileId: string | null;
  blocks: Block[];
}

/** The entity of the templates themselves: their files (the background PDF, images) are attachments of it. */
export const DOC_TEMPLATE_ENTITY = "kernel.doc_template";

/**
 * A template of the company (migration 0048), read through `kernel.v_doc_templates`. Configuration of the Parámetros section, written
 * only by `kernel.doc_template.save` and `kernel.doc_template.set_default`; attaching its background PDF needs the right to save it.
 */
export const docTemplateEntity = defineEntity({
  id: DOC_TEMPLATE_ENTITY,
  module: "kernel",
  schema: "kernel",
  table: "doc_templates",
  label: "entity.kernel.doc_template",
  entityType: "parametro",
  displayField: "name",
  defaultSort: { field: "name", dir: "asc" },
  processIds: { attach: "kernel.doc_template.save" },
  fields: [
    { name: "entity", type: "text", label: "field.kernel.doc_template.entity", required: true },
    { name: "scope", type: "enum", label: "field.kernel.doc_template.scope", required: true, enumValues: [...TEMPLATE_SCOPES] },
    { name: "name", type: "text", label: "field.kernel.doc_template.name", required: true },
    { name: "version", type: "number", label: "field.kernel.doc_template.version" },
    { name: "is_default", type: "boolean", label: "field.kernel.doc_template.is_default" },
    { name: "background_file_id", type: "uuid", label: "field.kernel.doc_template.background_file_id" },
    { name: "blocks", type: "json", label: "field.kernel.doc_template.blocks", exportable: false },
    { name: "created_at", type: "datetime", label: "field.kernel.doc_template.created_at" },
    { name: "updated_at", type: "datetime", label: "field.kernel.doc_template.updated_at" },
  ],
});
