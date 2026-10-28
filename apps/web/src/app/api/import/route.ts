import { MAX_ATTACHMENT_BYTES, runProcess } from "@erp/kernel";
import { buildTemplate, failImport, importFormatOf, previewImport, runImport, submitImport, type ImportFormat } from "@erp/kernel/import";
import { start } from "workflow/api";
import { callerOrResponse } from "@/lib/auth/http";
import { importLabels } from "@/lib/imports/labels";
import { processFailure, processProblem } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";

// Mass import over HTTP (design §5.11, §9). As the session's user:
//   POST  multipart { file, entity, mode: "preview" | "run", stepUpToken? }
//         preview → the file checked row by row in a dry run (kernel.import.preview), nothing written;
//         run     → kernel.import.run (step-up) creates the import record, the file is stored and attached to it,
//                   then the runImport workflow starts; answers 202 { importId } at once.
//   GET   ?entity=&format=xlsx|csv → the entity's template (kernel.import.template), Spanish headers.
//   GET   [?entity=]               → the company's import history (kernel.import.list).

/** Room for the multipart boundaries and fields around a file of the maximum size. */
const BODY_OVERHEAD_BYTES = 1024 * 1024;

export async function POST(request: Request): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES + BODY_OVERHEAD_BYTES) {
    return Response.json({ code: "invalid_input", details: ["El archivo supera los 25 MB"] }, { status: 413 });
  }
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const entity = form?.get("entity");
  const mode = form?.get("mode") ?? "preview";
  const stepUpToken = form?.get("stepUpToken");
  if (!(file instanceof File) || typeof entity !== "string" || (mode !== "preview" && mode !== "run")) {
    return processProblem("invalid_input", "Faltan campos: entity, mode y file");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return processProblem("invalid_input", "El archivo supera los 25 MB");

  const deps = processDeps();
  const upload = { entity, fileName: file.name.trim(), mimeType: file.type || "application/octet-stream", bytes: new Uint8Array(await file.arrayBuffer()) };
  try {
    const labels = await importLabels(deps.registry, entity);
    if (mode === "preview") return Response.json(await previewImport(deps, caller, upload, labels));

    const sensitive = typeof stepUpToken === "string" && stepUpToken !== "" ? { ...caller, stepUpToken } : caller;
    const { importId, chainId } = await submitImport(deps, sensitive, upload);
    try {
      // The import record and its file are committed: the workflow reads them by id.
      await start(runImport, [{ importId, chainId, claims: caller.claims, labels }]);
    } catch (error) {
      await failImport(deps.sql, { importId, chainId, claims: caller.claims }, "No se pudo iniciar la importación");
      throw error;
    }
    return Response.json({ importId }, { status: 202 });
  } catch (error) {
    return processFailure(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  const params = new URL(request.url).searchParams;
  const entity = params.get("entity");
  const format = params.get("format");
  const deps = processDeps();

  try {
    if (format === null) return Response.json(await runProcess(deps, caller, "kernel.import.list", entity ? { entity } : {}));
    if (entity === null || importFormatOf(`x.${format}`) !== format) return processProblem("invalid_input", "Faltan entity y format (xlsx o csv)");
    // The process checks the caller may import into the entity and audits the download.
    await runProcess(deps, caller, "kernel.import.template", { entity });
    const template = await buildTemplate(deps.registry, entity, format as ImportFormat, { labels: await importLabels(deps.registry, entity) });
    return new Response(Buffer.from(template.bytes), {
      headers: {
        "Content-Type": template.mimeType,
        "Content-Disposition": `attachment; filename="${template.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return processFailure(error);
  }
}
