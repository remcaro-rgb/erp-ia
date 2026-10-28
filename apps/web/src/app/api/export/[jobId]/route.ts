import { exportJobStatus } from "@erp/kernel/exports";
import { callerOrResponse } from "@/lib/auth/http";
import { processDeps } from "@/lib/server/runtime";

// GET /api/export/:jobId  ->  { status, rowCount?, fileName?, error?, url? }   (design §9)
// The state of an export job and, once it is done, a 10-minute signed download link. The job is read through
// kernel.v_export_jobs as the session's user, which only shows a member the jobs they started (company admins see
// every job of the company): somebody else's job, a job of another company and an unknown id are all 404, so the id
// alone never opens a file. 401 without a session.

type Context = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, context: Context): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  const { jobId } = await context.params;
  try {
    const status = await exportJobStatus(processDeps().sql, caller.claims, decodeURIComponent(jobId));
    if (!status) return Response.json({ code: "not_found", details: null }, { status: 404 });
    const { rowCount, fileName, error, url, ...rest } = status;
    return Response.json(
      { ...rest, ...(rowCount !== null ? { rowCount } : {}), ...(fileName ? { fileName } : {}), ...(error ? { error } : {}), ...(url ? { url } : {}) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error(error);
    return Response.json({ code: "handler_failed", details: null }, { status: 500 });
  }
}
