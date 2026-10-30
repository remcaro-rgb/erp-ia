import { defineProcess, ProcessError, visibleExtra, type ProcessDef } from "@erp/kernel";
import { z } from "zod";
import { DIMENSION_DEFS, type DimensionDef } from "../dimensions";
import { defined, invalid, refuseDuplicate } from "./common";
import { extraForCreate, extraForUpdate } from "./extra";
import { extra, extraFree, extraPatch, id, idOutput, name, nodeCode, rowOutput } from "./schemas";

// The four analytic dimensions (accounting design §4.5, §6) share one shape and one factory: a tree of groups and leaves per
// company, where only active leaves receive lines. No process deletes a node (the table grants no delete): a node with
// history is deactivated.

const kind = z.enum(["group", "leaf"]);

/** The create / update / consult processes of one dimension. */
export function dimensionProcesses(def: DimensionDef): ProcessDef[] {
  const table = `accounting.${def.table}`;
  const processId = (verb: string) => `${def.entity}.${verb}`;
  const codeKey = `${def.table}_company_id_code_key`;

  /** The parent of a node: an existing, active group of this dimension in the company. */
  async function requireGroupParent(ctx: Parameters<ProcessDef["handler"]>[0], parentId: string) {
    const [parent] = await ctx.tx<{ code: string; kind: string; is_active: boolean }[]>`
      select code, kind, is_active from ${ctx.tx(table)} where id = ${parentId} and company_id = ${ctx.companyId}`;
    if (!parent) throw invalid(`${def.entity} ${parentId} not found`, `No existe el ${def.noun} padre indicado`);
    if (parent.kind !== "group") throw invalid(`${def.entity} ${parent.code} is a leaf`, `El padre ${parent.code} es una hoja: solo un grupo puede tener hijos`);
    if (!parent.is_active) throw invalid(`${def.entity} ${parent.code} is inactive`, `El padre ${parent.code} está inactivo`);
  }

  const create = defineProcess({
    id: processId("create"),
    module: "accounting",
    kind: "create",
    feature: "accounting.ledger",
    description: `Crea un ${def.noun} (grupo u hoja) en su árbol analítico`,
    input: z.object({ code: nodeCode, name, parentId: id.nullable().optional(), kind, isActive: z.boolean().default(true), extra, extraFree: extraFree.optional() }).strict(),
    output: idOutput,
    handler: async (ctx, input) => {
      if (input.parentId) await requireGroupParent(ctx, input.parentId);
      const custom = await extraForCreate(ctx, def.entity, processId("create"), input);
      const [inserted] = await refuseDuplicate(processId("create"), codeKey, `Ya existe el ${def.noun} ${input.code}`, () => ctx.tx<{ id: string }[]>`
        insert into ${ctx.tx(table)} ${ctx.tx({
          company_id: ctx.companyId, code: input.code, name: input.name, parent_id: input.parentId ?? null, kind: input.kind,
          is_active: input.isActive, ...defined(custom),
        })}
        returning id`);
      return { id: inserted!.id };
    },
  });

  const update = defineProcess({
    id: processId("update"),
    module: "accounting",
    kind: "update",
    feature: "accounting.ledger",
    description: `Renombra, mueve, desactiva o cambia el tipo (grupo u hoja) de un ${def.noun}; el código no cambia`,
    input: z.object({ id, name: name.optional(), parentId: id.nullable().optional(), kind: kind.optional(), isActive: z.boolean().optional(), extra, extraPatch, extraFree: extraFree.optional() }).strict(),
    output: idOutput,
    handler: async (ctx, { id: nodeId, extraPatch: patch, ...input }) => {
      const [current] = await ctx.tx<{ kind: string; parent_id: string | null; extra: Record<string, unknown> }[]>`
        select kind, parent_id, extra from ${ctx.tx(table)} where id = ${nodeId} and company_id = ${ctx.companyId} for update`;
      if (!current) throw new ProcessError("not_found", `${def.entity} ${nodeId} not found`);

      if (input.parentId !== undefined && input.parentId !== current.parent_id && input.parentId !== null) {
        const [cycle] = await ctx.tx<{ hit: boolean }[]>`
          with recursive below as (
            select id from ${ctx.tx(table)} where id = ${nodeId}
            union all
            select t.id from ${ctx.tx(table)} t join below b on t.parent_id = b.id
          )
          select exists (select 1 from below where id = ${input.parentId}) as hit`;
        if (cycle!.hit) throw invalid(`${def.entity} ${nodeId} cannot move under itself`, `El ${def.noun} no puede quedar dentro de sí mismo ni de sus descendientes`);
        await requireGroupParent(ctx, input.parentId);
      }

      if (input.kind !== undefined && input.kind !== current.kind) {
        if (input.kind === "group") {
          const [lines] = await ctx.tx<{ used: boolean }[]>`
            select exists (select 1 from accounting.entry_lines where ${ctx.tx(def.column)} = ${nodeId})
                or exists (select 1 from accounting.entry_template_lines where ${ctx.tx(def.column)} = ${nodeId}) as used`;
          if (lines!.used) throw invalid(`${def.entity} ${nodeId} has lines`, `El ${def.noun} ya tiene movimientos: no puede pasar a ser un grupo, solo desactivarse`);
        } else {
          const [children] = await ctx.tx<{ used: boolean }[]>`select exists (select 1 from ${ctx.tx(table)} where parent_id = ${nodeId}) as used`;
          if (children!.used) throw invalid(`${def.entity} ${nodeId} has children`, `El ${def.noun} tiene hijos: no puede pasar a ser una hoja`);
        }
      }

      const custom = await extraForUpdate(ctx, def.entity, processId("update"), current.extra, { ...input, extraPatch: patch });
      const set = defined({ name: input.name, parent_id: input.parentId, kind: input.kind, is_active: input.isActive, ...custom });
      if (Object.keys(set).length > 0) await ctx.tx`update ${ctx.tx(table)} set ${ctx.tx(set)} where id = ${nodeId}`;
      return { id: nodeId };
    },
  });

  const consult = defineProcess({
    id: processId("consult"),
    module: "accounting",
    kind: "consult",
    feature: "accounting.ledger",
    description: `Consulta un ${def.noun} con los campos que el rol puede ver`,
    input: z.object({ id }),
    output: rowOutput,
    handler: async (ctx, { id: nodeId }) => {
      const [row] = await ctx.tx`select * from ${ctx.tx(`accounting.v_${def.table}`)} where id = ${nodeId}`;
      if (!row) throw new ProcessError("not_found", `${def.entity} ${nodeId} not found`);
      return { ...row, id: nodeId, extra: await visibleExtra(ctx, def.entity, row.extra) };
    },
  });

  return [create, update, consult] as unknown as ProcessDef[];
}

export const DIMENSION_PROCESSES: ProcessDef[] = Object.values(DIMENSION_DEFS).flatMap(dimensionProcesses);
