import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Caller } from "@erp/kernel";
import { paymentsHarness, type Harness } from "../../../../../../packages/modules/payments/src/__tests__/helpers";
import { loadPaymentsForm } from "@/lib/payments/record";

// The page's translator reads the request's locale; the section's logic does not depend on the words.
vi.mock("next-intl/server", () => ({ getTranslations: async () => Object.assign((key: string) => key, { has: () => true }), getLocale: async () => "es-419" }));

// The «Anticipos» section of a receipt reads the applications through the grid, as the caller (rule 14): a line or application field the role sees
// masked or hidden (the ones the section filters or sorts by) must not break the receipt's page; the section says the list is not available
// and still shows the figures it may (never guessed). A role that may not consult the lines gets the same.

let h: Harness;
let receipt: Record<string, unknown> & { id: string };

const memberRoleId = () => h.seed.companies[0]!.memberRoleId;
const clerk = (): Caller => ({ origin: "ui", claims: h.seed.claimsFor(h.seed.users.clerk, h.companyId) });

beforeAll(async () => {
  h = await paymentsHarness();
  const partyId = await h.newCustomer("900777111", "Cliente Tres S.A.S.");
  const advance = await h.advanceReceipt(300000, { partyId });
  const invoice = await h.issuedInvoice(1, { partyId });
  await h.apply([{ receiptId: advance.id, invoiceId: invoice.id, amount: 100000 }], { partyId });
  await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) select ${h.companyId}, ${memberRoleId()}, p from unnest(array['payments.advance.open','payments.advance_application.consult','payments.advance_application_line.consult','payments.advance.undo']::text[]) p on conflict do nothing`;
  receipt = (await h.sql<Record<string, unknown>[]>`select * from payments.receipts where id = ${advance.id}`)[0] as typeof receipt;
}, 300_000);

afterAll(async () => {
  await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId}`;
  await h.cleanup();
});

const mask = (entity: string, field: string, mode: "masked" | "hidden") => h.sql`
  insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${memberRoleId()}, ${entity}, ${field}, ${mode})
  on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
const unmask = () => h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${memberRoleId()}`;

describe("the Anticipos section with masked fields", () => {
  it("lists the applications for a role that sees the fields", async () => {
    const form = await loadPaymentsForm(clerk(), "payments.receipt", receipt);
    expect(form.view?.advances).toMatchObject({ access: "ok", applicationsAvailable: true });
    expect(form.view?.advances?.applications).toHaveLength(1);
  });

  it("does not throw when a field it filters or sorts by is masked or hidden: the list is unavailable, never guessed", async () => {
    for (const [entity, field, mode] of [
      ["payments.advance_application_line", "receipt_id", "masked"],
      ["payments.advance_application_line", "application_id", "hidden"],
      ["payments.advance_application_line", "line_no", "masked"],
      ["payments.advance_application", "seq", "masked"],
      ["payments.advance_application", "status", "hidden"],
    ] as const) {
      await mask(entity, field, mode);
      try {
        const form = await loadPaymentsForm(clerk(), "payments.receipt", receipt);
        expect(form.view?.advances, `${field} ${mode}`).toMatchObject({ access: "ok", applicationsAvailable: false, applications: [] });
      } finally {
        await unmask();
      }
    }
  });

  it("says the list is unavailable (not empty) when the role may not consult the lines", async () => {
    await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${memberRoleId()} and process_id = 'payments.advance_application_line.consult'`;
    const form = await loadPaymentsForm(clerk(), "payments.receipt", receipt);
    expect(form.view?.advances).toMatchObject({ applicationsAvailable: false, applications: [] });
  });
});
