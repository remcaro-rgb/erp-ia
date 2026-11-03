import type { EntityDef } from "../registry/entities";
import type { FieldDef } from "../registry/fields";
import type { Translate } from "../registry/labels";
import type { Block, Template, TemplateScope } from "./schema";

// The template an entity prints with when the company has none (entity types spec 2026-11-02 §6: "each entity ships a default template
// for both scopes, it works with no admin action"). Generated from the entity's fields, never stored: the company header (name, NIT,
// address, city, phone; the print date on the right), the title, then
//   - record: every printable field of the entity as label and value, two columns, and the table of its lines when it has them;
//   - list:   one table with the grid's columns (the grid state decides which, in its order).
// What the caller may not see prints empty (variables.ts); the labels are the caller's screen's (`presentation.labels`), else the
// registry's label keys read in the app's catalogue (`printLabels`).

/** A4 in points. */
export const A4 = { short: 595.28, long: 841.89 } as const;
const MARGIN = 40;

/** Fields that are not values of the record: the raw extra-data documents and other JSON. */
const RAW = new Set(["id", "extra", "extra_free"]);

/** The fields of `entity` a template prints (the default template lists them; a field block may name any of them). */
export function printableFields(entity: Pick<EntityDef, "fields">): FieldDef[] {
  return entity.fields.filter((f) => !RAW.has(f.name) && f.type !== "json" && f.exportable !== false);
}

export interface DefaultPresentation {
  /** The label of each field, in the caller's language (`printLabels`; the field name when absent). */
  labels?: Record<string, string>;
  /** The title printed under the header (the entity's name, the report's title). */
  title?: string;
  /** The name of the tax id printed before it (the country pack's, `NIT`); none, the tax id alone. */
  taxIdLabel?: string;
}

/**
 * The label of every field of `entities` as a print shows it: the caller's screen's (`given`), else the field's registry label key in the
 * app's catalogue (`t`), else (no catalogue registered) the field name.
 */
export function printLabels(entities: readonly Pick<EntityDef, "fields">[], t: Translate, given: Readonly<Record<string, string>> = {}): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const entity of entities) for (const field of entity.fields) labels[field.name] ??= given[field.name] ?? t(field.label) ?? field.name;
  return { ...labels, ...given };
}

function header(width: number, title: string | undefined, taxIdLabel: string | undefined): Block[] {
  const right = width - MARGIN - 220;
  // The tax id's label, as wide as its text (Helvetica bold 9 is about 5.5 points a letter).
  const labelWidth = taxIdLabel ? Math.max(26, Math.ceil(taxIdLabel.length * 5.5) + 6) : 0;
  const blocks: Block[] = [
    { kind: "variable", x: MARGIN, y: MARGIN, w: 320, font: { size: 13, bold: true }, value: "empresa.nombre" },
    ...(taxIdLabel ? [{ kind: "text" as const, x: MARGIN, y: MARGIN + 18, w: labelWidth, font: { size: 9, bold: true }, value: taxIdLabel }] : []),
    { kind: "variable", x: MARGIN + labelWidth, y: MARGIN + 18, w: 320 - labelWidth, font: { size: 9 }, value: "empresa.nit" },
    { kind: "variable", x: MARGIN, y: MARGIN + 30, w: 320, font: { size: 8 }, value: "empresa.direccion" },
    { kind: "variable", x: MARGIN, y: MARGIN + 41, w: 320, font: { size: 8 }, value: "empresa.ciudad" },
    { kind: "variable", x: MARGIN, y: MARGIN + 52, w: 320, font: { size: 8 }, value: "empresa.telefono" },
    { kind: "image", x: right + 120, y: MARGIN, w: 100, h: 40, value: "empresa.logo" },
    { kind: "variable", x: right, y: MARGIN + 46, w: 220, font: { size: 8 }, align: "right", value: "fecha_impresion" },
    { kind: "variable", x: right, y: MARGIN + 57, w: 220, font: { size: 8 }, align: "right", value: "usuario.nombre" },
  ];
  if (title) blocks.push({ kind: "text", x: MARGIN, y: MARGIN + 76, w: width - 2 * MARGIN, font: { size: 14, bold: true }, value: title });
  return blocks;
}

/** The built-in template of `entity` for `scope` (`id: null`, version 0, the default). */
export function defaultTemplate(entity: EntityDef, scope: TemplateScope, presentation: DefaultPresentation = {}): Template {
  const width = scope === "record" ? A4.short : A4.long;
  const height = scope === "record" ? A4.long : A4.short;
  const blocks: Block[] = header(width, presentation.title, presentation.taxIdLabel);
  const top = MARGIN + 110;
  if (scope === "record") {
    const fields = printableFields(entity);
    const column = (width - 2 * MARGIN) / 2;
    const rows = Math.ceil(fields.length / 2);
    fields.forEach((field, i) => {
      const x = MARGIN + (i < rows ? 0 : column);
      const y = top + (i % rows) * 18;
      blocks.push({ kind: "text", x, y, w: 100, font: { size: 8, bold: true }, value: presentation.labels?.[field.name] ?? field.name });
      blocks.push({ kind: "field", x: x + 104, y, w: column - 112, h: 16, font: { size: 9 }, value: field.name });
    });
    if (entity.typed?.lines) blocks.push({ kind: "lines", x: MARGIN, y: top + rows * 18 + 20, w: width - 2 * MARGIN, font: { size: 8 } });
  } else {
    blocks.push({ kind: "lines", x: MARGIN, y: top, w: width - 2 * MARGIN, font: { size: 8 } });
  }
  blocks.push({ kind: "page_number", x: MARGIN, y: height - 28, w: width - 2 * MARGIN, font: { size: 7 }, align: "center" });
  return { id: null, entity: entity.id, scope, name: presentation.title ?? entity.id, version: 0, isDefault: true, backgroundFileId: null, blocks };
}
