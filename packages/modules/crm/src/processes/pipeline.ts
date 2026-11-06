import { customData, defineProcess, ProcessError, visibleExtra, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { pipelineEntity, STAGE_KINDS, type StageKind } from "../entities";
import { assertWritable, defined, extra, followLifecycle, id, idInput, idOutput, initialLifecycle, maestroLifecycle, refuse, refuseDuplicate, rejectErrors } from "./common";

// Embudos and etapas (plan 2B Task 11): maestros (entity types spec §2.2) created Grabado (Pendiente de Aprobación when the company
// requires it). An embudo lists its etapas in order: the open ones first, then the ones that close the deal, at least one won and one lost.
// A won etapa has probability 100 and a lost one 0 (the table checks it). One embudo per company is the default one; the first embudo
// created becomes it, and a company with none gets the standard «Ventas» embudo the first time an oportunidad needs one.

const FEATURE = "crm.pipelines";

const code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,19}$/, "El código lleva de 1 a 20 letras, números, punto, guion o guion bajo");
const name = z.string().trim().min(1).max(120);

export const stageInput = z.object({
  /** An etapa of this embudo to keep (its deals stay in it); none adds a new one. */
  id: id.optional(),
  name: z.string().trim().min(1).max(80),
  /** Win probability, 0 to 100: a won etapa is 100 and a lost one 0 whatever is given. */
  probability: z.number().min(0).max(100).default(0),
  kind: z.enum(STAGE_KINDS).default("open"),
}).strict();

const pipelineFields = { code, name, description: z.string().trim().max(500).optional(), isDefault: z.boolean(), isActive: z.boolean() };
const PIPELINE_KEY = "pipelines_company_code_key";
const PIPELINE_WRITABLE = ["code", "name", "description", "is_default", "is_active", "extra", "extra_free"];

const columns = (input: Partial<z.output<z.ZodObject<typeof pipelineFields>>>) =>
  defined({ code: input.code, name: input.name, description: input.description, is_default: input.isDefault, is_active: input.isActive });

/** The standard embudo a company without any gets on first use: name, probability and kind of its etapas. */
export const STANDARD_STAGES: { name: string; probability: number; kind: StageKind }[] = [
  { name: "Nuevo", probability: 10, kind: "open" },
  { name: "Calificado", probability: 30, kind: "open" },
  { name: "Propuesta", probability: 60, kind: "open" },
  { name: "Negociación", probability: 80, kind: "open" },
  { name: "Ganada", probability: 100, kind: "won" },
  { name: "Perdida", probability: 0, kind: "lost" },
];

type StageDraft = z.output<typeof stageInput>;

/** The etapas as they will be stored (probability fixed by kind), or the reasons they are not a sound embudo. */
function normalizeStages(stages: readonly StageDraft[]): { stages: StageDraft[]; errors: string[] } {
  const errors: string[] = [];
  const fixed = stages.map((s) => ({ ...s, probability: s.kind === "won" ? 100 : s.kind === "lost" ? 0 : s.probability }));
  if (!fixed.some((s) => s.kind === "open")) errors.push("El embudo necesita al menos una etapa abierta");
  if (!fixed.some((s) => s.kind === "won")) errors.push("El embudo necesita una etapa de negocio ganado");
  if (!fixed.some((s) => s.kind === "lost")) errors.push("El embudo necesita una etapa de negocio perdido");
  const firstClosing = fixed.findIndex((s) => s.kind !== "open");
  if (firstClosing !== -1 && fixed.slice(firstClosing).some((s) => s.kind === "open")) errors.push("Las etapas abiertas van antes que las que cierran el negocio");
  fixed.forEach((s, i) => {
    if (s.kind === "open" && s.probability >= 100) errors.push(`Etapa ${i + 1}: una etapa abierta tiene menos de 100 % de probabilidad`);
  });
  const names = fixed.map((s) => s.name.toLowerCase());
  if (new Set(names).size !== names.length) errors.push("Los nombres de las etapas no se repiten");
  return { stages: fixed, errors };
}

const validExtra = async (ctx: ProcessContext, processId: string, stored: Record<string, unknown> | null, given: Record<string, unknown> | undefined) => {
  const custom = await customData(ctx, "crm.pipeline", stored, given);
  rejectErrors(processId, custom.errors);
  return given === undefined ? {} : { extra: ctx.tx.json(custom.extra as Parameters<typeof ctx.tx.json>[0]) };
};

/** Makes `pipelineId` the company's only default embudo. */
async function makeDefault(ctx: ProcessContext, pipelineId: string): Promise<void> {
  await ctx.tx`update crm.pipelines set is_default = false where is_default and id <> ${pipelineId} and deleted_at is null`;
  await ctx.tx`update crm.pipelines set is_default = true where id = ${pipelineId} and not is_default`;
}

export interface StageRow { id: string; pipeline_id: string; line_no: number; name: string; probability: string; kind: StageKind }

/** The etapas of an embudo in order. */
export async function stagesOf(ctx: ProcessContext, pipelineId: string): Promise<StageRow[]> {
  return ctx.tx<StageRow[]>`select id, pipeline_id, line_no, name, probability::text, kind from crm.stages where pipeline_id = ${pipelineId} order by line_no`;
}

/**
 * The company's default embudo: the one marked default and active, else the first active one (it becomes the default), else the standard
 * «Ventas» embudo created now. Serialized by an advisory lock so two first uses do not create two.
 */
export async function defaultPipeline(ctx: ProcessContext): Promise<{ id: string; stages: StageRow[] }> {
  await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`crm.pipeline.default:${ctx.companyId}`}, 0))`;
  let [found] = await ctx.tx<{ id: string }[]>`
    select id from crm.pipelines where is_active and deleted_at is null and status in ('saved', 'approved') order by is_default desc, seq limit 1`;
  if (!found) {
    const state = await initialLifecycle(ctx, "crm.pipeline");
    [found] = await ctx.tx<{ id: string }[]>`
      insert into crm.pipelines ${ctx.tx({ company_id: ctx.companyId, code: "VENTAS", name: "Ventas", description: "Embudo estándar de ventas", is_default: true, ...state })} returning id`;
    await insertStages(ctx, found!.id, STANDARD_STAGES, 1);
  } else {
    await makeDefault(ctx, found.id);
  }
  return { id: found!.id, stages: await stagesOf(ctx, found!.id) };
}

async function insertStages(ctx: ProcessContext, pipelineId: string, stages: readonly { name: string; probability: number; kind: StageKind }[], firstLine: number): Promise<{ id: string; lineNo: number }[]> {
  if (stages.length === 0) return [];
  const rows = await ctx.tx<{ id: string; line_no: number }[]>`
    insert into crm.stages ${ctx.tx(stages.map((s, i) => ({ company_id: ctx.companyId, pipeline_id: pipelineId, line_no: firstLine + i, name: s.name, probability: s.probability, kind: s.kind })))}
    returning id, line_no`;
  return rows.map((r) => ({ id: r.id, lineNo: r.line_no })).sort((a, b) => a.lineNo - b.lineNo);
}

export const pipelineCreate = defineProcess({
  id: "crm.pipeline.create",
  module: "crm",
  kind: "create",
  feature: FEATURE,
  description: "Crea un embudo de ventas con sus etapas en orden (abiertas primero, luego ganada y perdida)",
  input: z.object({
    ...pipelineFields,
    isDefault: pipelineFields.isDefault.default(false),
    isActive: pipelineFields.isActive.default(true),
    stages: z.array(stageInput.omit({ id: true })).min(3).max(30),
    extra,
  }).strict(),
  output: z.object({ id: z.string(), stages: z.array(z.object({ id: z.string(), lineNo: z.number(), name: z.string() })) }),
  handler: async (ctx, { stages, extra: given, ...input }) => {
    const normalized = normalizeStages(stages);
    rejectErrors("crm.pipeline.create", normalized.errors);
    const extraJson = await validExtra(ctx, "crm.pipeline.create", null, given);
    const state = await initialLifecycle(ctx, "crm.pipeline");
    const [first] = await ctx.tx`select 1 from crm.pipelines where deleted_at is null limit 1`;
    const [row] = await refuseDuplicate("crm.pipeline.create", PIPELINE_KEY, `Ya existe un embudo con el código ${input.code}`, () =>
      ctx.tx<{ id: string }[]>`
        insert into crm.pipelines ${ctx.tx({ company_id: ctx.companyId, ...columns({ ...input, isDefault: false }), ...extraJson, ...state })} returning id`,
    );
    if (input.isDefault || !first) await makeDefault(ctx, row!.id);
    const created = await insertStages(ctx, row!.id, normalized.stages, 1);
    return { id: row!.id, stages: created.map((c) => ({ id: c.id, lineNo: c.lineNo, name: normalized.stages[c.lineNo - 1]!.name })) };
  },
});

export const pipelineUpdate = defineProcess({
  id: "crm.pipeline.update",
  module: "crm",
  kind: "update",
  feature: FEATURE,
  description:
    "Actualiza un embudo: código, nombre, si es el predeterminado y si está activo; con etapas, las reemplaza en el nuevo orden (las que tienen negocios no se pueden quitar)",
  input: z.object(pipelineFields).partial().extend({ id, stages: z.array(stageInput).min(3).max(30).optional(), extra }).strict(),
  output: idOutput,
  handler: async (ctx, { id: pipelineId, stages, extra: given, ...input }) => {
    const [current] = await ctx.tx`select * from crm.pipelines where id = ${pipelineId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `pipeline ${pipelineId} not found`);
    const extraJson = await validExtra(ctx, "crm.pipeline.update", current.extra as Record<string, unknown> | null, given);
    const set = { ...columns({ ...input, isDefault: undefined }), ...extraJson };
    if (Object.keys(set).length > 0) {
      await refuseDuplicate("crm.pipeline.update", PIPELINE_KEY, `Ya existe un embudo con el código ${input.code ?? ""}`, () =>
        ctx.tx`update crm.pipelines set ${ctx.tx(set)} where id = ${pipelineId}`,
      );
    }
    if (input.isDefault === true) await makeDefault(ctx, pipelineId);
    if (input.isDefault === false && current.is_default === true) refuse("default_pipeline_required", ["Un embudo deja de ser el predeterminado cuando otro lo es: marca el otro como predeterminado"]);
    if (stages) await replaceStages(ctx, pipelineId, stages);
    await followLifecycle(ctx, "crm.pipeline", pipelineId, current);
    return { id: pipelineId };
  },
});

/** Replaces the etapas of an embudo with `stages` in order: given ids keep their deals, new ones are added, the rest go if no deal sits in them. */
async function replaceStages(ctx: ProcessContext, pipelineId: string, stages: readonly StageDraft[]): Promise<void> {
  const normalized = normalizeStages(stages);
  rejectErrors("crm.pipeline.update", normalized.errors);
  const current = await stagesOf(ctx, pipelineId);
  const byId = new Map(current.map((s) => [s.id, s]));
  const unknown = normalized.stages.filter((s) => s.id && !byId.has(s.id));
  if (unknown.length > 0) rejectErrors("crm.pipeline.update", unknown.map((s) => `La etapa ${s.name} no es de este embudo`));
  const kept = new Set(normalized.stages.flatMap((s) => (s.id ? [s.id] : [])));
  const dropped = current.filter((s) => !kept.has(s.id));
  if (dropped.length > 0) {
    const used = await ctx.tx<{ stage_id: string }[]>`select distinct stage_id from crm.opportunities where stage_id = any(${dropped.map((s) => s.id)}::uuid[])`;
    if (used.length > 0) {
      const names = dropped.filter((s) => used.some((u) => u.stage_id === s.id)).map((s) => s.name);
      refuse("stage_in_use", [`Las etapas ${names.join(", ")} tienen oportunidades: muévelas antes de quitarlas`]);
    }
    await ctx.tx`delete from crm.stages where id = any(${dropped.map((s) => s.id)}::uuid[])`;
  }
  // Out of the way first, so reordering never trips the unique (pipeline, line_no) and (pipeline, name) keys.
  await ctx.tx`update crm.stages set line_no = line_no + 100000, name = id::text where pipeline_id = ${pipelineId}`;
  const added: { index: number; stage: StageDraft }[] = [];
  for (const [index, stage] of normalized.stages.entries()) {
    if (!stage.id) {
      added.push({ index, stage });
      continue;
    }
    const before = byId.get(stage.id)!;
    if (before.kind !== stage.kind) {
      const [deal] = await ctx.tx`select 1 from crm.opportunities where stage_id = ${stage.id} limit 1`;
      if (deal) refuse("stage_in_use", [`La etapa ${before.name} tiene oportunidades: no cambia de tipo`]);
    }
    await ctx.tx`update crm.stages set line_no = ${index + 1}, name = ${stage.name}, probability = ${stage.probability}, kind = ${stage.kind} where id = ${stage.id}`;
  }
  for (const { index, stage } of added) {
    await ctx.tx`insert into crm.stages ${ctx.tx({ company_id: ctx.companyId, pipeline_id: pipelineId, line_no: index + 1, name: stage.name, probability: stage.probability, kind: stage.kind })}`;
  }
}

export const pipelineConsult = defineProcess({
  id: "crm.pipeline.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta un embudo con sus etapas y los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: pipelineId }) => {
    const [row] = await ctx.tx`select * from crm.v_pipelines where id = ${pipelineId}`;
    if (!row) throw new ProcessError("not_found", `pipeline ${pipelineId} not found`);
    const stages = await ctx.tx`select * from crm.v_stages where pipeline_id = ${pipelineId} order by line_no`;
    return { ...row, id: pipelineId, extra: await visibleExtra(ctx, "crm.pipeline", row.extra), stages };
  },
});

export const stageConsult = defineProcess({
  id: "crm.stage.consult",
  module: "crm",
  kind: "consult",
  feature: FEATURE,
  description: "Consulta una etapa de un embudo con los campos que el rol puede ver",
  input: idInput,
  output: z.looseObject({ id: z.string() }),
  handler: async (ctx, { id: stageId }) => {
    const [row] = await ctx.tx`select * from crm.v_stages where id = ${stageId}`;
    if (!row) throw new ProcessError("not_found", `stage ${stageId} not found`);
    return { ...row, id: stageId };
  },
});

/** The validate hook of an embudo (Grabar, Aprobar): the stored record passes the create schema, keeps its etapas sound and the custom fields. */
export const pipelineHooks: TypedHooks = {
  async validate(ctx, record, mode, { data }) {
    const processId = `crm.pipeline.${mode === "approve" ? "approve" : "save"}`;
    assertWritable(processId, data, PIPELINE_WRITABLE);
    const parsed = z.object({ code, name }).safeParse({ code: record.code, name: record.name });
    if (!parsed.success) rejectErrors(processId, parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
    const custom = await customData(ctx, "crm.pipeline", record.extra as Record<string, unknown> | null, undefined);
    rejectErrors(processId, custom.errors);
  },
};

export const PIPELINE_PROCESSES = [
  pipelineCreate, pipelineUpdate, pipelineConsult, stageConsult,
  ...maestroLifecycle(pipelineEntity, FEATURE, { constraint: PIPELINE_KEY, detail: "Ya existe un embudo con ese código" }),
];
