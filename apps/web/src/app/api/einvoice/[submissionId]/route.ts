import { runProcess } from "@erp/kernel";
import { SIGNED_URL_TTL_SECONDS } from "@erp/infra";
import { callerOrResponse } from "@/lib/auth/http";
import { processFailure as fail, processProblem as problem } from "@/lib/server/process-response";
import { fileStore, processDeps } from "@/lib/server/runtime";

// The files of a DIAN submission (plan 2B Task 20, rule 22): GET /api/einvoice/<submission id>?file=xml|response|pdf answers a redirect to
// a short-lived signed link of the signed XML, the DIAN's ApplicationResponse or the stored PDF. The submission is read as the session's
// user through invoicing.einvoice_submission.consult (its masked view: RLS, the caller's role and the read right of its invoice or note);
// a path the caller does not see, or one outside the caller's company folder, is not there. The bucket has no user policy: the bytes are
// only reached through this signed link, made with the service role.

const FILES = {
  xml: { column: "xml_path", name: "documento-electronico.xml" },
  response: { column: "response_path", name: "respuesta-dian.xml" },
  pdf: { column: "pdf_path", name: "representacion-grafica.pdf" },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ submissionId: string }> }): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  const { submissionId } = await params;
  const which = new URL(request.url).searchParams.get("file");
  if (!UUID.test(submissionId) || (which !== "xml" && which !== "response" && which !== "pdf")) return problem("invalid_input", "Indica el envío y el archivo: xml, response o pdf");
  try {
    const row = (await runProcess(processDeps(), caller, "invoicing.einvoice_submission.consult", { id: submissionId })) as Record<string, unknown>;
    const file = FILES[which];
    const path = row[file.column];
    const folder = `${caller.claims.tenant_id}/${caller.claims.active_company_id}/`;
    if (typeof path !== "string" || !path.startsWith(folder) || path.includes("..")) return problem("not_found", "No se encontró el archivo");
    const url = await fileStore().signedUrl(path, SIGNED_URL_TTL_SECONDS, file.name);
    return Response.redirect(url, 303);
  } catch (error) {
    return fail(error);
  }
}
