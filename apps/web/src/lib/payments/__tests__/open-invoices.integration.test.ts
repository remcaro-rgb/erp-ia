import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "@erp/kernel";
import { paymentsHarness, type Harness } from "../../../../../../packages/modules/payments/src/__tests__/helpers";
import { openInvoicesFor } from "@/lib/payments/open-invoices";

// «Registrar pago» lists the customer's invoices from invoicing's published, unmasked view, so it answers only to a caller who sees the
// invoice's number and money fields as they are (plan 2B Task 40, Ruling R40-2, rule 14): a masked or hidden field is a typed `forbidden`.

let h: Harness;
let partyId: string;
let invoice: { id: string; number: string };

// The company's admin role is exempt from field masks, so the member role (the harness's clerk) is the caller.
const adminRoleId = () => h.seed.companies[0]!.memberRoleId;
const clerk = (): Caller => ({ origin: "ui", claims: h.seed.claimsFor(h.seed.users.clerk, h.companyId) });

beforeAll(async () => {
  h = await paymentsHarness();
  partyId = await h.newCustomer("900777888", "Cliente Uno S.A.S.");
  invoice = await h.issuedInvoice(1, { partyId });
  await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${adminRoleId()}, 'payments.payment.open_invoices') on conflict do nothing`;
}, 300_000);

afterAll(async () => {
  await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId}`;
  await h.cleanup();
});

const mask = (field: string, mode: "masked" | "hidden") => h.sql`
  insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${adminRoleId()}, 'invoicing.invoice', ${field}, ${mode})
  on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
const unmask = () => h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${adminRoleId()}`;

describe("openInvoicesFor (Registrar pago's list of open invoices)", () => {
  it("answers a role that sees the invoice amounts", async () => {
    const answer = await openInvoicesFor(clerk(), partyId);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.invoices).toHaveLength(1);
    expect(answer.invoices[0]).toMatchObject({ id: invoice.id, number: invoice.number, total: 119000, open: 119000, payable: true });
  });

  it("refuses with `forbidden` when the invoice's number or a money field is masked or hidden", async () => {
    for (const [field, mode] of [["total", "masked"], ["number", "masked"], ["paid_amount", "hidden"], ["credited_amount", "masked"], ["debited_amount", "masked"]] as const) {
      await mask(field, mode);
      try {
        expect(await openInvoicesFor(clerk(), partyId), `${field} ${mode}`).toMatchObject({ ok: false, code: "forbidden" });
      } finally {
        await unmask();
      }
    }
    expect(await openInvoicesFor(clerk(), partyId)).toMatchObject({ ok: true });
  });
});
