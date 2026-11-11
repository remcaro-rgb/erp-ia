import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "@erp/infra";
import { setSecretStore, type Caller } from "@erp/kernel";
import { invoicingHarness, type Harness, type InvoiceOut } from "../../../../../../packages/modules/invoicing/src/__tests__/helpers";

// «Reintentar todos» (plan 2B Task 37, R37-4, R37-5): the web action is a thin passthrough; the process is the single place of the rule, so a
// member who holds the process (but is not the company's administrator) gets `{ ok: false, code: "forbidden" }` and nothing is requeued, and
// the administrator gets `ok: true` with the invoices requeued.

let h: Harness;
let current: Caller;
vi.mock("@/lib/auth/claims", () => ({ requireCaller: async () => current }));
vi.mock("@/lib/auth/disabled", () => ({ signOutIfDisabled: async () => undefined }));
// The action runs on the harness's registry and database.
vi.mock("@/lib/server/runtime", async () => {
  const { registry } = await import("../../../../../../packages/modules/invoicing/src/__tests__/helpers");
  const { testDb } = await import("@erp/kernel/testing");
  return { processDeps: () => ({ sql: testDb(), registry }) };
});

let invoiceId: string;
// Real key material in the store the processes read: the answers below must carry none of it.
const SECRETS = { certificate: "MIIKSENTINELp12ZmFrZWNlcnRpZmljYXRl", pin: "SENTINELPIN-75315", pem: "-----BEGIN PRIVATE KEY-----" };
const store = new InMemorySecretStore();

beforeAll(async () => {
  h = await invoicingHarness();
  setSecretStore(store);
  await store.set(`dian/${h.companyId}/certificate`, `${SECRETS.pem}\n${SECRETS.certificate}`);
  await store.set(`dian/${h.companyId}/pin`, SECRETS.pin);
  await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${h.memberRoleId}, 'invoicing.invoice.resubmit_failed') on conflict do nothing`;
  await h.runStepUp("invoicing.settings.update", { softwareId: null });
  const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.servicio, qty: 1 }] });
  await h.run(h.admin, "invoicing.invoice.issue", { id: draft.id });
  expect(await h.drain()).toEqual([]);
  await h.runStepUp("invoicing.settings.update", { softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0" });
  await h.sql`update invoicing.einvoice_submissions set status = 'failed', last_error = 'einvoice_transport: caída' where invoice_id = ${draft.id} and note_id is null`;
  invoiceId = draft.id;
}, 300_000);

afterAll(async () => {
  await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${h.memberRoleId} and process_id = 'invoicing.invoice.resubmit_failed'`;
  await h.cleanup();
});

const requests = async () => Number((await h.sql<{ n: string }[]>`select count(*)::text n from kernel.outbox where company_id = ${h.companyId} and event = 'invoicing.invoice.resubmit_requested' and payload->>'invoiceId' = ${invoiceId}`)[0]!.n);

describe("runInvoicingSettingsAction(\"resubmit\")", () => {
  it("answers a non-administrator who holds the process with `forbidden` and requeues nothing", async () => {
    const { runInvoicingSettingsAction } = await import("../actions");
    current = h.member;
    const before = await requests();
    const answer = await runInvoicingSettingsAction("resubmit", {});
    expect(answer).toMatchObject({ ok: false, code: "forbidden" });
    expect(await requests()).toBe(before);
    const [row] = await h.sql<{ status: string }[]>`select status from invoicing.einvoice_submissions where invoice_id = ${invoiceId} and note_id is null`;
    expect(row!.status).toBe("failed");
    // Nothing secret in the refusal.
    expect(JSON.stringify(await store.get(`dian/${h.companyId}/certificate`))).toContain("BEGIN");
    for (const bad of Object.values(SECRETS)) expect(JSON.stringify(answer)).not.toContain(bad);
  });

  it("answers the administrator ok with the requeued invoices", async () => {
    const { runInvoicingSettingsAction } = await import("../actions");
    current = h.admin;
    const before = await requests();
    const answer = await runInvoicingSettingsAction("resubmit", {});
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect((answer.data.requeued as { invoiceId: string }[]).map((r) => r.invoiceId)).toContain(invoiceId);
    expect(await requests()).toBe(before + 1);
    for (const bad of Object.values(SECRETS)) expect(JSON.stringify(answer)).not.toContain(bad);
  });
});
