import { ProcessError, ReportState, reportDenial, reportOf, runReport } from "@erp/kernel";
import { callerOrResponse } from "@/lib/auth/http";
import { processFailure } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";
import { z } from "zod";

// POST /api/report/:id  body { params, state: GridState }  ->  { rows, total, aggregates? }   (design §9, accounting design §10a.5)
// One window of a report, read as the session's user by running the report's consult process: company RLS, field
// masking and the consult's own permission apply. 401 without a session; 403 when the company is not entitled to the
// report's feature, no role of the caller may run its consult, or an `x-company-id` header names any company but the
// active one; 404 for an unknown report; 400 for a body, parameters or state the report refuses.

type Context = { params: Promise<{ id: string }> };

/** Parameters and a grid state are a few hundred bytes; anything this large is not one. */
const MAX_BODY_BYTES = 64 * 1024;

const body = z.object({ params: z.record(z.string(), z.unknown()).default({}), state: ReportState });

const problem = (status: number, code: string, details: unknown = null) => Response.json({ code, details }, { status });

export async function POST(request: Request, context: Context): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  const { claims } = caller;

  const company = request.headers.get("x-company-id");
  if (company !== null && company !== claims.active_company_id) return problem(403, "forbidden", ["x-company-id is not the active company of the session"]);

  let id: string;
  try {
    id = decodeURIComponent((await context.params).id);
  } catch {
    return problem(404, "not_found");
  }
  const deps = processDeps();
  const def = reportOf(deps, id);
  if (!def) return problem(404, "not_found");

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return problem(413, "invalid_input", ["body too large"]);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, "invalid_input", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));

  const denial = await reportDenial(deps, claims, def);
  if (denial) return problem(denial === "not_found" ? 404 : 403, denial);

  try {
    const { rows, total, aggregates } = await runReport(deps, caller, id, parsed.data.params, parsed.data.state);
    return Response.json(aggregates ? { rows, total, aggregates } : { rows, total });
  } catch (error) {
    if (error instanceof ProcessError && error.code === "invalid_input") return problem(400, "invalid_input", error.details ?? null);
    return processFailure(error);
  }
}
