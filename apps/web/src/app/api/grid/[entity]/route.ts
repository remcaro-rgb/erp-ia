import { GridState, QueryError, runGridQuery } from "@erp/kernel";
import { callerOrResponse } from "@/lib/auth/http";
import { gridDenial, gridEntity } from "@/lib/grid/access";
import { processDeps } from "@/lib/server/runtime";

// POST /api/grid/:entity  body GridState  ->  { rows, total, aggregates?, groups? }   (design §9, rules 14, 20 and 21)
// One page of an entity's grid, read as the session's user over the entity's masked view: company RLS, the party
// scope and field masking apply, so a hidden or masked column comes back null. 401 without a session; 403 when the
// company is not entitled to the entity's feature, no role of the caller may consult it, a hidden or masked field
// is filtered, sorted or aggregated, or an `x-company-id` header names any company but the active one (a header
// may confirm the active company of the claims, never switch it); 404 for an unknown entity; 400 on a bad state.

type Context = { params: Promise<{ entity: string }> };

/** A grid state is a few hundred bytes; anything this large is not one. */
const MAX_BODY_BYTES = 64 * 1024;

const problem = (status: number, code: string, details: unknown = null) => Response.json({ code, details }, { status });

export async function POST(request: Request, context: Context): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  const { claims } = caller;

  const company = request.headers.get("x-company-id");
  if (company !== null && company !== claims.active_company_id) return problem(403, "forbidden", ["x-company-id is not the active company of the session"]);

  let entityId: string;
  try {
    entityId = decodeURIComponent((await context.params).entity);
  } catch {
    return problem(404, "not_found");
  }
  const deps = processDeps();
  const entity = gridEntity(deps.registry, entityId);
  if (!entity) return problem(404, "not_found");

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return problem(413, "invalid_input", ["body too large"]);
  const parsed = GridState.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return problem(400, "invalid_input", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));

  const denial = await gridDenial(deps, claims, entity);
  if (denial) return problem(denial === "not_found" ? 404 : 403, denial);

  try {
    // Each row names the records its references point to (`<field>_label`), for the cells that link to them (rule 21).
    const { rows, total, aggregates, groups } = await runGridQuery(deps.sql, claims, entity, parsed.data, { registry: deps.registry });
    return Response.json({ rows, total, ...(aggregates ? { aggregates } : {}), ...(groups ? { groups } : {}) });
  } catch (error) {
    if (error instanceof QueryError) return problem(error.code === "field_hidden" ? 403 : 400, error.code, [error.field]);
    console.error(error);
    return problem(500, "handler_failed");
  }
}
