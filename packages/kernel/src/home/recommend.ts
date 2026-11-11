import { z } from "zod";
import type { Tx } from "../db/client";
import { ProcessError } from "../process/errors";
import type { Registry } from "../registry";

// The kernel recommendation API (design §22.28, owner items 26 and 36, plan 2B Task 38): what a registered create or update process raises
// for the people who can act on it, through ctx.recommendations. A row names who sees it (the holders of a process, or a role), what it is
// about (the subject: entity and record), why (a reason code of the raising module) and the values its catalogue text shows, each tagged
// with the field it is so the kernel masks it per viewer (rule 14). One open row per subject and reason: a second raise merges. The
// process that fixes the cause closes it in the same transaction. Writes go only through the definer functions of migration 0123, which
// refuse anything but the running process naming itself (rule 1).

const PROCESS_ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;
/** How many values one recommendation's text may name. */
export const RECOMMENDATION_PARAMS_MAX = 20;

/** A value the title or body names: shown as is, or masked when the viewer does not see `entity.field`. */
export const recommendationParam = z
  .object({ value: z.union([z.string().max(200), z.number(), z.null()]), entity: z.string().min(1).max(100).optional(), field: z.string().min(1).max(100).optional() })
  .strict()
  .refine((p) => (p.entity === undefined) === (p.field === undefined), "entity and field go together");
export type RecommendationParam = z.infer<typeof recommendationParam>;

export const recommendationRaiseInput = z
  .object({
    /** The holders of this process are the audience (`kernel.can_run_process`, asked on every read). */
    audienceProcess: z.string().regex(PROCESS_ID).optional(),
    /** Or the holders of a role (at least one of the two). */
    audienceRoleId: z.uuid().optional(),
    subject: z.object({ entity: z.string().min(1).max(100), id: z.uuid() }).strict(),
    reason: z.string().min(1).max(100).regex(/^[a-z][a-z0-9_]*$/),
    titleKey: z.string().min(1).max(200),
    bodyKey: z.string().min(1).max(200),
    params: z
      .record(z.string().regex(/^[a-z][a-zA-Z0-9]*$/), recommendationParam)
      .refine((p) => Object.keys(p).length <= RECOMMENDATION_PARAMS_MAX, `at most ${RECOMMENDATION_PARAMS_MAX} params`)
      .default({}),
  })
  .strict()
  .refine((r) => r.audienceProcess !== undefined || r.audienceRoleId !== undefined, "a recommendation needs an audience process or role");
export type RecommendationRaise = z.input<typeof recommendationRaiseInput>;

export const recommendationCloseInput = z
  .object({ subject: z.object({ entity: z.string().min(1).max(100), id: z.uuid() }).strict(), reason: z.string().min(1).max(100).optional() })
  .strict();
export type RecommendationClose = z.input<typeof recommendationCloseInput>;

/** ctx.recommendations: present on every runProcess context (nested ones get their own, under their own process). */
export interface RecommendationsApi {
  /** Raises (or merges into the open row of the same subject and reason); `merged` says which. */
  raise(input: RecommendationRaise): Promise<{ id: string; merged: boolean }>;
  /** Closes the open rows of the subject (every reason, or the one named): the cause was fixed. */
  close(input: RecommendationClose): Promise<{ closed: number }>;
}

/** The value of each stored param (`{ value, entity?, field? }`), as the view hands it: masked or malformed values read as null. */
export function paramValues(stored: unknown): Record<string, string | number | null> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  return Object.fromEntries(
    Object.entries(stored as Record<string, unknown>).map(([key, param]) => {
      const value = typeof param === "object" && param !== null && "value" in param ? (param as { value: unknown }).value : null;
      return [key, typeof value === "string" || typeof value === "number" ? value : null];
    }),
  );
}

/** The catalogue key of a reason: in the raising module's namespace (rule 24), `<module>.recommendation.reason.<reason>`. */
export function reasonKeyOf(module: string | null, reason: string | null): string | null {
  return module && reason ? `${module}.recommendation.reason.${reason}` : null;
}

function invalid(message: string, details?: unknown[]): never {
  throw new ProcessError("invalid_input", message, { details: details ?? [message] });
}

/** The registered entity, or a refusal: a typo in a subject or a param must not reach a viewer unmasked. */
function entityOf(registry: Registry, id: string) {
  try {
    return registry.entity(id);
  } catch {
    return invalid(`recommendation names an unregistered entity: ${id}`);
  }
}

/**
 * The ctx.recommendations of the run of `processId`, in its transaction. Refuses (`forbidden`) from a process that is not a create or an
 * update and (`invalid_input`) a subject, param entity or field, or audience process the registry does not know; the definer functions
 * refuse again in SQL whatever is not the running process naming itself.
 */
export function makeRecommendations(tx: Tx, registry: Registry, processId: string): RecommendationsApi {
  const writer = () => {
    const kind = registry.process(processId).kind;
    if (kind !== "create" && kind !== "update") throw new ProcessError("forbidden", `${processId} is a ${kind} process: it may not write recommendations`);
  };
  return {
    async raise(raw) {
      writer();
      const parsed = recommendationRaiseInput.safeParse(raw);
      if (!parsed.success) invalid(`invalid recommendation from ${processId}`, parsed.error.issues);
      const input = parsed.data;
      entityOf(registry, input.subject.entity);
      for (const [name, param] of Object.entries(input.params)) {
        if (param.entity === undefined) continue;
        const entity = entityOf(registry, param.entity);
        if (!entity.fields.some((f) => f.name === param.field)) invalid(`recommendation param ${name} names a field ${param.entity}.${param.field} that does not exist`);
      }
      if (input.audienceProcess !== undefined) {
        try {
          registry.process(input.audienceProcess);
        } catch {
          invalid(`recommendation audience is an unregistered process: ${input.audienceProcess}`);
        }
      }
      const [row] = await tx<{ id: string; merged: boolean }[]>`
        select id, merged from kernel.recommendation_raise(
          ${processId}, ${input.audienceProcess ?? null}, ${input.audienceRoleId ?? null}::uuid, ${input.subject.entity}, ${input.subject.id}::uuid,
          ${input.reason}, ${input.titleKey}, ${input.bodyKey}, ${tx.json(input.params as never)}::jsonb)`;
      return { id: row!.id, merged: row!.merged };
    },
    async close(raw) {
      writer();
      const parsed = recommendationCloseInput.safeParse(raw);
      if (!parsed.success) invalid(`invalid recommendation close from ${processId}`, parsed.error.issues);
      const { subject, reason } = parsed.data;
      const [row] = await tx<{ closed: number }[]>`
        select kernel.recommendation_close(${processId}, ${subject.entity}, ${subject.id}::uuid, ${reason ?? null}) as closed`;
      return { closed: row!.closed };
    },
  };
}
