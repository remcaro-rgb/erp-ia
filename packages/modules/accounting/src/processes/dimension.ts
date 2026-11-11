import { defineProcess, ProcessError, visibleExtra, type ProcessContext, type ProcessDef, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { DIMENSION_DEFS, type DimensionDef } from "../dimensions";
import { entityDef } from "../entities";
import { defined, invalid, refuseDuplicate } from "./common";
import { extraForCreate, extraForUpdate } from "./extra";
import { assertRefsExist, assertWritable, followLifecycle, initialLifecycle, lifecycleProcesses } from "./lifecycle";
import { extra, extraFree, extraPatch, id, idOutput, name, nodeCode, rowOutput } from "./schemas";

// The four analytic dimensions (accounting design §4.5, §6) share one shape and one factory: a tree of groups and leaves per
// company, where only active leaves receive lines. No process deletes a node (the table grants no delete): a node with
// history is deactivated.

const kind = z.enum(["group", "leaf"]);

/** The columns a dimension's update process writes: the code never changes. */
const WRITABLE = new Set(["name", "parent_id", "kind", "is_active", "extra", "extra_free"]);

/** The checks of a node's update, shared by `<dimension>.update` and the lifecycle hook of its generic Grabar (Task 8b). */
function dimensionChecks(def: DimensionDef) {
  const table = `accounting.${def.table}`;

  /** The parent of a node: an existing, active group of this dimension in the company. */
  async function requireGroupParent(ctx: ProcessContext, parentId: string) {
    const [parent] = await ctx.tx<{ code: string; kind: string; is_active: boolean }[]>`
      select code, kind, is_active from ${ctx.tx(table)} where id = ${parentId} and company_id = ${ctx.companyId} and deleted_at is null`;
    if (!parent) throw invalid(`${def.entity} ${parentId} not found`, `No existe el ${def.noun} padre indicado`);
    if (parent.kind !== "group") throw invalid(`${def.entity} ${parent.code} is a leaf`, `El padre ${parent.code} es una hoja: solo un grupo puede tener hijos`);
    if (!parent.is_active) throw invalid(`${def.entity} ${parent.code} is inactive`, `El padre ${parent.code} está inactivo`);
  }

  /** Moving `nodeId` under `parentId`: not under itself nor a descendant, and only under an active group. */
  async function assertParent(ctx: ProcessContext, nodeId: string, parentId: string) {
    // `union` (not `union all`): the hook runs after the row is written, when a refused move may already close a loop.
    const [cycle] = await ctx.tx<{ hit: boolean }[]>`
      with recursive below as (
        select id from ${ctx.tx(table)} where id = ${nodeId}
        union
        select t.id from ${ctx.tx(table)} t join below b on t.parent_id = b.id
      )
      select exists (select 1 from below where id = ${parentId}) as hit`;
    if (cycle!.hit) throw invalid(`${def.entity} ${nodeId} cannot move under itself`, `El ${def.noun} no puede quedar dentro de sí mismo ni de sus descendientes`);
    await requireGroupParent(ctx, parentId);
  }

  /** A leaf with lines does not become a group; a group with children does not become a leaf. */
  async function assertKind(ctx: ProcessContext, nodeId: string, next: string) {
    if (next === "group") {
      const [lines] = await ctx.tx<{ used: boolean }[]>`
        select exists (select 1 from accounting.entry_lines where ${ctx.tx(def.column)} = ${nodeId})
            or exists (select 1 from accounting.entry_template_lines where ${ctx.tx(def.column)} = ${nodeId}) as used`;
      if (lines!.used) throw invalid(`${def.entity} ${nodeId} has lines`, `El ${def.noun} ya tiene movimientos: no puede pasar a ser un grupo, solo desactivarse`);
    } else {
      const [children] = await ctx.tx<{ used: boolean }[]>`select exists (select 1 from ${ctx.tx(table)} where parent_id = ${nodeId} and deleted_at is null) as used`;
      if (children!.used) throw invalid(`${def.entity} ${nodeId} has children`, `El ${def.noun} tiene hijos: no puede pasar a ser una hoja`);
    }
  }
  return { requireGroupParent, assertParent, assertKind };
}

/** The lifecycle hook of a dimension: Grabar writes only the update process's columns and runs its checks. */
export function dimensionHooks(def: DimensionDef): TypedHooks {
  const checks = dimensionChecks(def);
  return {
    async validate(ctx, record, mode, change) {
      if (mode !== "save") return;
      assertWritable(`${def.entity}.save`, change.data, WRITABLE);
      if (typeof record.name !== "string" || record.name.trim() === "") throw invalid(`${def.entity} name is empty`, `El ${def.noun} lleva un nombre`);
      const parentId = record.parent_id as string | null;
      if (parentId && parentId !== change.previous.parent_id) await checks.assertParent(ctx, record.id, parentId);
      if (record.kind !== change.previous.kind) await checks.assertKind(ctx, record.id, String(record.kind));
    },
  };
}

/** The create / update / consult processes of one dimension, and its lifecycle processes. */
export function dimensionProcesses(def: DimensionDef): ProcessDef[] {
  const table = `accounting.${def.table}`;
  const processId = (verb: string) => `${def.entity}.${verb}`;
  const codeKey = `${def.table}_company_id_code_key`;
  const { requireGroupParent, assertParent, assertKind } = dimensionChecks(def);

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
      const lifecycle = await initialLifecycle(ctx, def.entity);
      const [inserted] = await refuseDuplicate(processId("create"), codeKey, `Ya existe el ${def.noun} ${input.code}`, () => ctx.tx<{ id: string }[]>`
        insert into ${ctx.tx(table)} ${ctx.tx({
          company_id: ctx.companyId, code: input.code, name: input.name, parent_id: input.parentId ?? null, kind: input.kind,
          is_active: input.isActive, ...defined(custom), ...lifecycle,
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
        select * from ${ctx.tx(table)} where id = ${nodeId} and company_id = ${ctx.companyId} and deleted_at is null for update`;
      if (!current) throw new ProcessError("not_found", `${def.entity} ${nodeId} not found`);
      if (input.parentId !== undefined && input.parentId !== current.parent_id && input.parentId !== null) await assertParent(ctx, nodeId, input.parentId);
      if (input.kind !== undefined && input.kind !== current.kind) await assertKind(ctx, nodeId, input.kind);

      const custom = await extraForUpdate(ctx, def.entity, processId("update"), current.extra, { ...input, extraPatch: patch });
      const set = defined({ name: input.name, parent_id: input.parentId, kind: input.kind, is_active: input.isActive, ...custom });
      if (Object.keys(set).length > 0) await ctx.tx`update ${ctx.tx(table)} set ${ctx.tx(set)} where id = ${nodeId}`;
      await followLifecycle(ctx, def.entity, nodeId, current);
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

  const lifecycle = lifecycleProcesses(entityDef(def.entity), "accounting.ledger", {
    writable: WRITABLE,
    before: { save: (ctx, input) => assertRefsExist(ctx, input.data, { parent_id: { table, noun: `el ${def.noun} padre` } }) },
  });
  return [create, update, consult, ...lifecycle] as unknown as ProcessDef[];
}

export const DIMENSION_PROCESSES: ProcessDef[] = Object.values(DIMENSION_DEFS).flatMap(dimensionProcesses);
