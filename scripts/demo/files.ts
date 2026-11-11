/**
 * The required files of a demo party (RUT, and Cámara de Comercio for a company), as the Archivos tab adds them (POST /api/attachments):
 * precheck, the bytes in the store, then kernel.attachment.add. A tag the party already has is skipped. LOCAL USE ONLY (scripts/seed.ts and
 * scripts/demo/sales.ts); the files are placeholder PDFs that say so.
 */
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { precheckAttachment, runProcess, type Caller, type RunProcessDeps } from "@erp/kernel";
import type { FileStore } from "@erp/infra";
import { DEMO_COMPANY_ID } from "./accounts";

/** A one-page PDF that says it stands in for the document (the required files need a real PDF). */
export function placeholderPdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, "");
  const stream = `BT /F1 14 Tf 72 720 Td (${text} - documento de demostracion) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** Attaches each missing tag of `tags` to the party; answers how many it added. */
export async function attachRequiredFiles(
  sql: Sql, deps: RunProcessDeps, caller: Caller, store: FileStore,
  party: { partyId: string; document: string; name: string; tags: readonly string[] },
): Promise<number> {
  let added = 0;
  for (const tag of party.tags) {
    const [present] = await sql`
      select 1 from kernel.attachments where company_id = ${DEMO_COMPANY_ID} and entity = 'core.party' and record_id = ${party.partyId} and tag = ${tag} and removed_at is null`;
    if (present) continue;
    const bytes = placeholderPdf(`${tag} ${party.name}`);
    const fileName = `${tag === "RUT" ? "rut" : "camara-de-comercio"}-${party.document}.pdf`;
    const target = { entity: "core.party", recordId: party.partyId, tag, fileName, mimeType: "application/pdf", sizeBytes: bytes.length };
    await precheckAttachment(deps, caller, target);
    const storagePath = `${caller.claims.tenant_id}/${DEMO_COMPANY_ID}/core.party/${party.partyId}/${randomBytes(8).toString("hex")}-${fileName}`;
    await store.put(storagePath, bytes, "application/pdf");
    await runProcess(deps, caller, "kernel.attachment.add", { ...target, storagePath });
    added++;
  }
  return added;
}
