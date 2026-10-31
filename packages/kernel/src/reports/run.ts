import { entitled } from "../entitlements/resolver";
import type { JwtClaims } from "../db/client";
import type { Caller } from "../process/context";
import { ProcessError } from "../process/errors";
import { runnableProcesses } from "../process/permissions";
import { runProcess, type RunProcessDeps } from "../process/run";
import type { ReportDef, ReportFileAction, ReportResult } from "./types";
import type { ReportState } from "./state";

/** The registered report `id`, or null. */
export function reportOf(deps: Pick<RunProcessDeps, "registry">, id: string): ReportDef | null {
  try {
    return deps.registry.report(id);
  } catch {
    return null;
  }
}

export type ReportDenial = "not_found" | "not_entitled" | "forbidden";

/**
 * Null when the caller may run the report in the active company, else why not: its module is not loaded
 * (`not_found`), the company is not entitled to its feature (`not_entitled`), or no role of the caller may run its
 * consult (`forbidden`). `runProcess` checks the same again on the run itself.
 */
export async function reportDenial(deps: RunProcessDeps, claims: JwtClaims, def: ReportDef): Promise<ReportDenial | null> {
  const { registry, sql } = deps;
  if (!registry.hasModule(def.module)) return "not_found";
  if (!(await (deps.entitled ?? entitled)(sql, claims.active_company_id, `feature:${def.feature}`))) return "not_entitled";
  const runnable = await runnableProcesses(sql, registry, claims, [def.consult]);
  return runnable.has(def.consult) ? null : "forbidden";
}

/**
 * Runs a report as the caller: its consult process with `{ params, state }`. Throws `ProcessError`: `not_found` for an
 * unknown report, `invalid_input` for parameters the report's schema refuses, and the consult's own refusals
 * (`not_entitled`, `forbidden`).
 */
export async function runReport(deps: RunProcessDeps, caller: Caller, id: string, params: unknown, state: ReportState): Promise<ReportResult> {
  const def = reportOf(deps, id);
  if (!def) throw new ProcessError("not_found", `unknown report ${id}`);
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new ProcessError("invalid_input", `invalid parameters for report ${id}`, { details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  return runProcess<never>(deps, caller, def.consult, { params: parsed.data, state }) as Promise<ReportResult>;
}

export interface ReportFile {
  fileName: string;
  content: string;
  contentType: string;
}

/**
 * Runs file action `actionId` of report `id` as the caller: the action's process with the report's parameters as its
 * input, through `runProcess`, so permission, entitlement, sensitivity (step-up) and the process's own refusals apply.
 * Throws `ProcessError`: `not_found` for an unknown report or action, `invalid_input` for parameters the report's schema
 * refuses or a process that answered no document.
 */
export async function runReportFile(deps: RunProcessDeps, caller: Caller, id: string, actionId: string, params: unknown): Promise<ReportFile> {
  const def = reportOf(deps, id);
  if (!def) throw new ProcessError("not_found", `unknown report ${id}`);
  const action: ReportFileAction | undefined = def.fileActions?.find((a) => a.id === actionId);
  if (!action) throw new ProcessError("not_found", `report ${id} has no file action ${actionId}`);
  const parsed = def.params.safeParse(params ?? {});
  if (!parsed.success) throw new ProcessError("invalid_input", `invalid parameters for report ${id}`, { details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  const out = (await runProcess<never>(deps, caller, action.process, parsed.data)) as Record<string, unknown>;
  const content = out[action.contentField];
  if (typeof out.fileName !== "string" || typeof content !== "string") throw new ProcessError("handler_failed", `${action.process} answered no ${action.contentField}`);
  return { fileName: out.fileName, content, contentType: action.contentType };
}
