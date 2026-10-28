import { randomUUID } from "node:crypto";
import { getServiceDb, MAX_ATTACHMENT_BYTES, ProcessError, runProcess, type Caller } from "@erp/kernel";
import { SIGNED_URL_TTL_SECONDS } from "@erp/infra";
import { sessionCaller } from "@/lib/auth/caller";
import { fileStore, processDeps } from "@/lib/server/runtime";

// Attachments over HTTP (design §5.13). POST stores the bytes in the private bucket and registers
// them with kernel.attachment.add as the session's user; GET ?entity=&recordId= lists a record's files
// (kernel.attachment.list); GET ?id= answers a 60 s signed download link after the same list confirms
// the caller may see the file; DELETE ?id= removes a file (kernel.attachment.remove, soft). The bucket
// has no user policy: bytes only move through this handler, with the service role.

const STATUS: Record<ProcessError["code"], number> = {
  not_entitled: 403,
  forbidden: 403,
  step_up_required: 401,
  invalid_input: 400,
  not_found: 404,
  idempotent_replay: 409,
  handler_failed: 500,
};

function fail(error: unknown): Response {
  if (error instanceof ProcessError) {
    return Response.json({ code: error.code, details: error.details ?? null }, { status: STATUS[error.code] });
  }
  console.error(error);
  return Response.json({ code: "handler_failed", details: null }, { status: 500 });
}

const problem = (code: ProcessError["code"], detail: string) => Response.json({ code, details: [detail] }, { status: STATUS[code] });

/** Storage keys avoid accents and spaces; the original name stays in the attachment row. */
const storageName = (fileName: string) => fileName.normalize("NFKD").replace(/[^\w.-]+/g, "_");

export async function POST(request: Request): Promise<Response> {
  const caller = await sessionCaller();
  if (!caller) return problem("forbidden", "No hay sesión");

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  const entity = form?.get("entity");
  const recordId = form?.get("recordId");
  const tag = form?.get("tag");
  if (!(file instanceof File) || typeof entity !== "string" || typeof recordId !== "string" || typeof tag !== "string") {
    return problem("invalid_input", "Faltan campos: entity, recordId, tag y file");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) return problem("invalid_input", "El archivo supera los 25 MB");

  const { tenant_id: tenantId, active_company_id: companyId } = caller.claims;
  const fileName = file.name.trim();
  const storagePath = `${tenantId}/${companyId}/${entity}/${recordId}/${randomUUID()}-${storageName(fileName)}`;
  const mimeType = file.type || "application/octet-stream";
  const store = fileStore();

  await store.put(storagePath, Buffer.from(await file.arrayBuffer()), mimeType);
  try {
    const { storagePath: _stored, ...attachment } = await runProcess(processDeps(), caller, "kernel.attachment.add", {
      entity,
      recordId,
      tag,
      fileName,
      mimeType,
      sizeBytes: file.size,
      storagePath,
    });
    void _stored;
    return Response.json(attachment, { status: 201 });
  } catch (error) {
    // The process refused (permission, duplicate, wrong type…): do not leave the bytes behind.
    await store.remove(storagePath).catch((cleanup: unknown) => console.error("attachment cleanup failed", cleanup));
    return fail(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  const caller: Caller | null = await sessionCaller();
  if (!caller) return problem("forbidden", "No hay sesión");
  const params = new URL(request.url).searchParams;
  const id = params.get("id");
  const entity = params.get("entity");
  const recordId = params.get("recordId");

  try {
    if (id === null && entity !== null && recordId !== null) {
      const items = await runProcess(processDeps(), caller, "kernel.attachment.list", { entity, recordId });
      return Response.json(items);
    }
    if (id === null) return problem("invalid_input", "Falta el parámetro id, o entity y recordId");

    // Service connection, narrowed to the caller's active company; the list process below is the real gate.
    const [row] = await getServiceDb()<{ entity: string; record_id: string; storage_path: string; file_name: string }[]>`
      select entity, record_id, storage_path, file_name from kernel.attachments
      where id::text = ${id} and company_id = ${caller.claims.active_company_id} and removed_at is null`;
    if (!row) return problem("not_found", "No se encontró el archivo");
    const visible = await runProcess(processDeps(), caller, "kernel.attachment.list", { entity: row.entity, recordId: row.record_id });
    if (!visible.some((attachment: { id: string }) => attachment.id === id)) return problem("not_found", "No se encontró el archivo");
    const url = await fileStore().signedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    return Response.json({ url, fileName: row.file_name, expiresIn: SIGNED_URL_TTL_SECONDS });
  } catch (error) {
    return fail(error);
  }
}

/** Soft delete: the row and the stored bytes stay for the audit. */
export async function DELETE(request: Request): Promise<Response> {
  const caller = await sessionCaller();
  if (!caller) return problem("forbidden", "No hay sesión");
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return problem("invalid_input", "Falta el parámetro id");
  try {
    return Response.json(await runProcess(processDeps(), caller, "kernel.attachment.remove", { id }));
  } catch (error) {
    return fail(error);
  }
}
