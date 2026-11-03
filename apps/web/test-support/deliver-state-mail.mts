// Test helper (e2e, Task 16): delivers one `<entity>.status_changed` outbox row to the kernel's state e-mail consumer, as the dispatch
// workflow's step does, with the local stack's SMTP sink as the transport. Run with tsx (the PDF renderer is an ES module the Playwright
// loader cannot import): `tsx test-support/deliver-state-mail.mts <outbox id>`. TEST_SMTP_HOST / TEST_SMTP_PORT name the sink.
import postgres from "postgres";
import { SmtpMailer } from "@erp/infra";
import { translate } from "@erp/i18n";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry, setMailer } from "@erp/kernel";
import { testEnv } from "./env";

const id = process.argv[2];
if (!id) throw new Error("usage: deliver-state-mail.mts <outbox id>");

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support]);
  registerCountryPack(co);
  registerCatalogue(translate);
  setMailer(new SmtpMailer({ host: process.env.TEST_SMTP_HOST ?? "127.0.0.1", port: Number(process.env.TEST_SMTP_PORT ?? "54325"), from: "erp@cafedelnorte.test" }));
  const [row] = await sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string; company_id: string }[]>`
    select id, event, payload, created_at, chain_id, company_id from kernel.outbox where id = ${id}`;
  if (!row) throw new Error(`outbox row ${id} not found`);
  const consumer = consumers.for(row.event).find((c) => c.moduleId === "kernel");
  if (!consumer) throw new Error(`no kernel consumer of ${row.event}`);
  await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: row.company_id, chainId: row.chain_id }, registry), row.payload);
  console.log(`delivered ${row.event} ${row.id}`);
} finally {
  await sql.end({ timeout: 5 });
}
// The kernel's own pools and the SMTP client keep handles open: the delivery is done.
process.exit(0);
