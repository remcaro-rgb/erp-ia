// Test helper (e2e, plan 2B Task 20): the mock DIAN answers one issued invoice or note, as the e-invoice workflow's steps record it (the e2e
// stack runs no worker and no Workflow World): the submission requested by the issued event's consumer step (origin event, the event's
// chain), claimed by a run, the signed document kept (a placeholder XML in the file store), sent with the mock's trackId, and the verdict
// recorded by invoicing.invoice.dian_result / invoicing.note.dian_result with the DIAN's errors of a rejection and the ApplicationResponse.
// The same processes the workflow runs (Task 17); only the signing and the transport are left out (they are covered by the workflow's own
// integration tests on the mock transport).
// `tsx test-support/mock-dian.mts <invoice|note> <id> <accepted|rejected> [error…]`
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { translate } from "@erp/i18n";
import { SupabaseFileStore } from "@erp/infra";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { invoicing } from "@erp/module-invoicing";
import { inventory } from "@erp/module-inventory";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";
import { buildConsumerContext, kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry } from "@erp/kernel";
import { testEnv } from "./env";

const [kind, id, verdict, ...errors] = process.argv.slice(2);
if ((kind !== "invoice" && kind !== "note") || !id || (verdict !== "accepted" && verdict !== "rejected")) {
  throw new Error("usage: mock-dian.mts <invoice|note> <id> <accepted|rejected> [error…]");
}

const env = testEnv();
const sql = postgres(env.DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  const event = kind === "invoice" ? "invoicing.invoice.issued" : "invoicing.note.issued";
  const key = kind === "invoice" ? "invoiceId" : "noteId";
  const [row] = await sql<{ id: string; event: string; created_at: Date; chain_id: string; company_id: string }[]>`
    select id, event, created_at, chain_id, company_id from kernel.outbox where event = ${event} and payload->>${key} = ${id} order by created_at desc limit 1`;
  if (!row) throw new Error(`no ${event} for ${id}`);
  const ctx = buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: row.company_id, chainId: row.chain_id }, registry);
  const target = kind === "invoice" ? { invoiceId: id } : { noteId: id };
  const requested = (await ctx.runProcess("invoicing.einvoice_submission.request", target)) as { submissionId: string };
  const runId = `mock-${randomUUID()}`;
  const claimed = (await ctx.runProcess("invoicing.einvoice_submission.record", { action: "claim", id: requested.submissionId, runId })) as { owned: boolean; submission: { round: number } };
  if (!claimed.owned) throw new Error(`the submission ${requested.submissionId} is not waiting to be sent`);
  const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${row.company_id}`;
  const dir = `${company!.tenant_id}/${row.company_id}/einvoice/${id}/r${claimed.submission.round}-${runId}`;
  const xmlPath = `${dir}/documento.xml`;
  const responsePath = `${dir}/respuesta-dian.xml`;
  // The files the workflow keeps (placeholders: the mock signs nothing); the page's download links read them.
  try {
    const store = SupabaseFileStore.fromEnv({ SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY });
    await store.put(xmlPath, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Invoice><!-- mock ${id} --></Invoice>`), "application/xml");
    await store.put(responsePath, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><ApplicationResponse><ResponseCode>${verdict === "accepted" ? "02" : "04"}</ResponseCode></ApplicationResponse>`), "application/xml");
  } catch (error) {
    console.warn(`mock files not stored: ${error instanceof Error ? error.message : String(error)}`);
  }
  await ctx.runProcess("invoicing.einvoice_submission.record", { action: "submitting", id: requested.submissionId, runId, xmlPath });
  await ctx.runProcess("invoicing.einvoice_submission.record", { action: "submitted", id: requested.submissionId, runId, trackId: `mock-track-${id.slice(0, 8)}-${claimed.submission.round}` });
  await ctx.runProcess(kind === "invoice" ? "invoicing.invoice.dian_result" : "invoicing.note.dian_result", {
    id, submissionId: requested.submissionId, runId, status: verdict, errors: verdict === "rejected" ? errors : [], xmlPath, responsePath,
  });
  console.log(JSON.stringify({ submissionId: requested.submissionId, verdict }));
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(0);
