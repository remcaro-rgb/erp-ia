import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { ledgerOrStockReason, NESTED_HARD_MAX, NESTED_RETRY_PROCESS } from "../process/nested-policy";
import { ADMIN_FEATURE, invalid, requireAdmin } from "./common";

// Configurable nested runs (owner decisions item 1, plan 2B Task 32, migration 0126). The company admin edits the pairs and the depth through
// two step-up processes of kernel.admin (rule 15; also when narrowing, decisions item 72); the failure queue is retried or dismissed through
// two processes of the feature kernel.nested_failures, which the permission matrix can grant to a role. Every write goes through a definer
// function that refuses outside the run of its process (rule 1).

/** The feature of the failure queue's processes (not kernel.admin, so the matrix can grant them to a role). */
export const NESTED_FAILURES_FEATURE = "kernel.nested_failures";

export const nestedRunPairSet = defineProcess({
  id: "kernel.admin.nested_run.pair.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description:
    "Configura una ejecución anidada (proceso padre → proceso anidado): si la verificación en dos pasos del padre cubre al anidado y si un fallo del anidado revierte todo o continúa y queda en la cola de fallos",
  input: z.object({
    parent: z.string().trim().min(1, "Elige el proceso padre"),
    nested: z.string().trim().min(1, "Elige el proceso anidado"),
    totpCovers: z.boolean(),
    onFailure: z.enum(["rollback", "continue"]),
  }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const known = new Set(ctx.registry.processes().map((p) => p.id));
    for (const id of [input.parent, input.nested]) {
      if (!known.has(id)) throw invalid(`unknown process ${id}`, `El proceso ${id} no existe`);
    }
    if (input.parent === input.nested) throw invalid(`${input.parent} cannot nest in itself`, "Un proceso no puede anidarse en sí mismo");
    const nested = ctx.registry.process(input.nested);
    if (nested.nestedOnlyFrom && !nested.nestedOnlyFrom.includes(input.parent)) {
      throw invalid(`${nested.id} runs only nested in ${nested.nestedOnlyFrom.join(", ")}`, `Ese proceso solo corre dentro de: ${nested.nestedOnlyFrom.join(", ")}`);
    }
    // Refused at save time and at run time (R32-5): a nested run that posts to the ledger or moves stock never continues after a failure.
    const reason = ledgerOrStockReason(ctx.registry, nested.id);
    if (input.onFailure === "continue" && reason !== null) {
      throw invalid(reason, "Una ejecución anidada que contabiliza o mueve existencias no puede continuar tras un fallo");
    }
    const [row] = await ctx.tx<{ id: string }[]>`select kernel.nested_run_pair_set(${input.parent}, ${input.nested}, ${input.totpCovers}, ${input.onFailure}) as id`;
    return { id: row!.id };
  },
});

export const nestedRunDepthSet = defineProcess({
  id: "kernel.admin.nested_run.depth.set",
  module: "kernel",
  kind: "update",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: `Fija cuántos niveles de ejecuciones anidadas permite la empresa (de 1 a ${NESTED_HARD_MAX}; 4 si no se fija)`,
  input: z.object({ maxDepth: z.number().int("Debe ser un número entero").min(1, "Mínimo 1 nivel").max(NESTED_HARD_MAX, `Máximo ${NESTED_HARD_MAX} niveles`) }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    const [row] = await ctx.tx<{ id: string }[]>`select kernel.nested_run_depth_set(${input.maxDepth}) as id`;
    return { id: row!.id };
  },
});

export const NESTED_RUN_PROCESSES = [nestedRunPairSet, nestedRunDepthSet];

/** The original chain and actor of the row a retry replays, keyed by the run's parsed input (read by its auditInput, same object). */
const RETRY_MARKS = new WeakMap<object, { original_chain_id: string; original_actor_id: string }>();

export const nestedFailureRetry = defineProcess({
  id: NESTED_RETRY_PROCESS,
  module: "kernel",
  kind: "update",
  feature: NESTED_FAILURES_FEATURE,
  sensitivity: "step-up",
  description: "Reintenta una ejecución anidada que falló y quedó en la cola de fallos, como el usuario que reintenta y en el contexto de su proceso padre",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string(), status: z.literal("resolved") }),
  // The run's success row carries the marks the handler read from the queue row (fix round 1, M6): handed over on the parsed input object.
  auditInput: (input) => ({ id: input.id, retry_of: input.id, ...RETRY_MARKS.get(input) }),
  handler: async (ctx, input) => {
    const { id } = input;
    const [failure] = await ctx.tx<{ parent_process: string; nested_process: string; input: unknown; chain_id: string; actor_user_id: string }[]>`
      select * from kernel.nested_failure_take(${id}::uuid)`;
    if (!failure) throw new ProcessError("not_found", `nested failure ${id} is not pending`);
    if (!ctx.runProcess) throw new ProcessError("handler_failed", "the retry needs a context that can run a nested process");
    // As the retrying user, in the original parent's pair context, always rolling back on failure (R32-8): a failing retry fails the retry.
    await ctx.runProcess(failure.nested_process, failure.input, { asParent: failure.parent_process });
    const marks = { retry_of: id, original_chain_id: failure.chain_id, original_actor_id: failure.actor_user_id };
    RETRY_MARKS.set(input, { original_chain_id: failure.chain_id, original_actor_id: failure.actor_user_id });
    const nested = ctx.registry.process(failure.nested_process);
    const action = ({ create: "insert", update: "update", delete: "delete", consult: "consult" } as const)[nested.kind];
    await ctx.audit({
      processId: nested.id,
      entity: nested.id.slice(0, nested.id.lastIndexOf(".")),
      action,
      input: { code: "nested_run_retried", parent_process: failure.parent_process, ...marks },
    });
    await ctx.audit({ input: { code: "nested_run_retried", nested_process: nested.id, ...marks } });
    const [closed] = await ctx.tx<{ closed: boolean }[]>`select kernel.nested_failure_close(${id}::uuid, 'resolved', ${ctx.chainId}::uuid) as closed`;
    if (!closed?.closed) throw new ProcessError("not_found", `nested failure ${id} is not pending`);
    return { id, status: "resolved" as const };
  },
});

export const nestedFailureDismiss = defineProcess({
  id: "kernel.nested_failure.dismiss",
  module: "kernel",
  kind: "update",
  feature: NESTED_FAILURES_FEATURE,
  description: "Descarta una ejecución anidada de la cola de fallos sin reintentarla; la fila se conserva como descartada",
  input: z.object({ id: z.uuid() }),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { id }) => {
    const [closed] = await ctx.tx<{ closed: boolean }[]>`select kernel.nested_failure_close(${id}::uuid, 'dismissed', null) as closed`;
    if (!closed?.closed) throw new ProcessError("not_found", `nested failure ${id} is not pending`);
    return { id };
  },
});

export const NESTED_FAILURE_PROCESSES = [nestedFailureRetry, nestedFailureDismiss];
