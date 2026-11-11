import { z } from "zod";
import { ProcessError } from "../process/errors";
import { defineProcess } from "../process/define";

// kernel.document_link.trail (design §22.27, plan 2B Task 31): the documents a record comes from and the ones made from it, walked over
// kernel.document_links as the caller (kernel.document_trail, security invoker) to a depth and a size cap. A registered consult, so the
// record page and the assistant read it through the same pipeline (rules 1 and 17). A document the caller may not see is walked through
// but never named: it is only counted in `hidden`, and a visible document reached from it carries no kind and no voided flag (they would
// name it or tell its void). The links are read through the definer kernel.document_link_step, which answers inside this run only.
// The labels (document number, kind name) come from the web's title resolver and catalogue: no number is read here.

export const trailInput = z
  .object({
    entity: z.string().min(1).max(100),
    id: z.uuid(),
    direction: z.enum(["up", "down", "both"]).default("both"),
    depth: z.number().int().min(1).max(12).default(6),
    cap: z.number().int().min(1).max(500).default(100),
  })
  .strict();
export type TrailInput = z.input<typeof trailInput>;

export const trailNode = z.object({
  direction: z.enum(["up", "down"]),
  depth: z.number().int(),
  /** The kind of the link that reached it; null when the document it was reached from is hidden from the caller. */
  kind: z.string().nullable(),
  entity: z.string(),
  id: z.uuid(),
  /** The link that reached it is marked voided («Anulado»); false when it was reached from a hidden document (that would tell its void). */
  voided: z.boolean(),
});
export type TrailNode = z.infer<typeof trailNode>;
export const trailResult = z.object({
  nodes: z.array(trailNode),
  /** How many documents on the walk the caller may not see (never which). */
  hidden: z.number().int(),
  /** The depth or the cap left documents out. */
  truncated: z.boolean(),
});
export type TrailResult = z.infer<typeof trailResult>;

interface Row {
  depth: number;
  direction: "up" | "down";
  kind: string | null;
  entity: string | null;
  id: string | null;
  voided: boolean | null;
  visible: boolean;
  truncated: boolean;
}

export const documentLinkTrail = defineProcess({
  id: "kernel.document_link.trail",
  module: "kernel",
  kind: "consult",
  description:
    "Consulta los documentos relacionados de un registro: de dónde viene (origen) y qué se hizo a partir de él (derivados), hasta 6 niveles y 100 documentos por defecto; los documentos que el usuario no puede ver solo se cuentan",
  input: trailInput,
  output: trailResult,
  handler: async (ctx, input) => {
    // The start must be a record the caller sees (its consult and its read view), exactly as one that does not exist.
    const [start] = await ctx.tx<{ visible: boolean }[]>`select kernel.document_visible(${input.entity}, ${input.id}::uuid) as visible`;
    if (start?.visible !== true) throw new ProcessError("not_found", `${input.entity} ${input.id} not found`);
    const rows = await ctx.tx<Row[]>`
      select depth, direction, kind, entity, id, voided, visible, truncated
      from kernel.document_trail(${input.entity}, ${input.id}::uuid, ${input.direction}, ${input.depth}::int, ${input.cap}::int)`;
    const nodes: TrailNode[] = rows
      .filter((r) => r.visible && r.entity !== null && r.id !== null)
      .map((r) => ({ direction: r.direction, depth: r.depth, kind: r.kind, entity: r.entity!, id: r.id!, voided: r.voided === true }));
    return { nodes, hidden: rows.filter((r) => !r.visible).length, truncated: rows.some((r) => r.truncated) };
  },
});
