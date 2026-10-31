import { randomUUID } from "node:crypto";
import {
  ProcessError,
  exportsStore,
  reportDenial,
  reportOf,
  runReportFile,
} from "@erp/kernel";
import { EXPORT_URL_TTL_SECONDS } from "@erp/kernel/exports";
import { callerOrResponse } from "@/lib/auth/http";
import { processFailure } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";
import { z } from "zod";

// POST /api/report/:id/file/:action  body { params, stepUpToken? }  ->  { url, fileName }   (accounting design §5.11, §10a.5; design §5.13)
// A report's file action (the exógena's XML): the action's process runs as the session's user with the report's
// parameters, so permission, sensitivity (step-up, bound to the caller) and the process's own refusals apply. On success
// the document goes to the exports store and the answer is a signed link of EXPORT_URL_TTL_SECONDS; a refusal stores
// nothing. 401 without a session or when step-up is required; 403 when the company is not entitled to the report's
// feature, no role may run the process, or an `x-company-id` header names any company but the active one; 404 for an
// unknown report or action; 400 for parameters the report refuses or a document the process refuses to write.

type Context = { params: Promise<{ id: string; action: string }> };

/** Parameters are a few hundred bytes; anything this large is not a report's. */
const MAX_BODY_BYTES = 64 * 1024;

const body = z.object({
  params: z.record(z.string(), z.unknown()).default({}),
  stepUpToken: z.string().min(1).max(200).optional(),
});

const problem = (status: number, code: string, details: unknown = null) =>
  Response.json({ code, details }, { status });

export async function POST(
  request: Request,
  context: Context,
): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  const { claims } = caller;

  const company = request.headers.get("x-company-id");
  if (company !== null && company !== claims.active_company_id)
    return problem(403, "forbidden", [
      "x-company-id is not the active company of the session",
    ]);

  let id: string;
  let actionId: string;
  try {
    const raw = await context.params;
    id = decodeURIComponent(raw.id);
    actionId = decodeURIComponent(raw.action);
  } catch {
    return problem(404, "not_found");
  }
  const deps = processDeps();
  const def = reportOf(deps, id);
  if (!def || !def.fileActions?.some((a) => a.id === actionId))
    return problem(404, "not_found");

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    return problem(413, "invalid_input", ["body too large"]);
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return problem(
      400,
      "invalid_input",
      parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    );

  const denial = await reportDenial(deps, claims, def);
  if (denial) return problem(denial === "not_found" ? 404 : 403, denial);

  // The token binds to the caller inside runProcess (the verification row names the user and the company).
  const runner = parsed.data.stepUpToken
    ? { ...caller, stepUpToken: parsed.data.stepUpToken }
    : caller;
  try {
    const file = await runReportFile(
      deps,
      runner,
      id,
      actionId,
      parsed.data.params,
    );
    const store = await exportsStore();
    const path = `${claims.active_company_id}/report-files/${randomUUID()}/${file.fileName}`;
    await store.put(path, Buffer.from(file.content), file.contentType);
    return Response.json({
      url: await store.signedUrl(path, EXPORT_URL_TTL_SECONDS, file.fileName),
      fileName: file.fileName,
    });
  } catch (error) {
    if (error instanceof ProcessError && error.code === "invalid_input")
      return problem(400, "invalid_input", error.details ?? null);
    return processFailure(error);
  }
}
