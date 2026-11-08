import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Caller } from "@erp/kernel";
import { paymentsHarness, type Harness } from "../../../../../../packages/modules/payments/src/__tests__/helpers";
import { openAdvancesFor } from "@/lib/payments/advances";

// «Aplicar a facturas» lists the customer's receipts with an advance left (payments.advance.open). The screen shows it only to a caller who sees
// the receipt's number, date, advance, customer and status, and the applications' amount (the applied figure), as they are (plan 2B.2 Task 36,
// R36-10, rule 14): a masked or hidden field is a typed `forbidden`, never a list with the figures guessed or blanked.

let h: Harness;
let partyId: string;
let receiptId: string;

// The company's admin role is exempt from field masks, so the member role (the harness's clerk) is the caller.
const memberRoleId = () => h.seed.companies[0]!.memberRoleId;
const clerk = (): Caller => ({ origin: "ui", claims: h.seed.claimsFor(h.seed.users.clerk, h.companyId) });

beforeAll(async () => {
  h = await paymentsHarness();
  partyId = await h.newCustomer("900777999", "Cliente Dos S.A.S.");
  receiptId = (await h.advanceReceipt(500000, { partyId })).id;
  await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${memberRoleId()}, 'payments.advance.open') on conflict do nothing`;
}, 300_000);

afterAll(async () => {
  await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId}`;
  await h.cleanup();
});

const mask = (entity: string, field: string, mode: "masked" | "hidden") => h.sql`
  insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${memberRoleId()}, ${entity}, ${field}, ${mode})
  on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
const unmask = () => h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${memberRoleId()}`;

describe("openAdvancesFor (the advances «Aplicar a facturas» draws on)", () => {
  it("answers a role that sees the receipt's figures", async () => {
    const answer = await openAdvancesFor(clerk(), partyId);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.advances).toHaveLength(1);
    expect(answer.advances[0]).toMatchObject({ receiptId, advance: 500000, applied: 0, remaining: 500000 });
  });

  it("refuses with `forbidden` when a field the list is made of is masked or hidden", async () => {
    for (const [entity, field, mode] of [
      ["payments.receipt", "advance", "masked"],
      ["payments.receipt", "number", "masked"],
      ["payments.receipt", "date", "hidden"],
      ["payments.receipt", "party_id", "masked"],
      ["payments.receipt", "status", "masked"],
      ["payments.advance_application_line", "amount", "masked"],
    ] as const) {
      await mask(entity, field, mode);
      try {
        expect(await openAdvancesFor(clerk(), partyId), `${entity}.${field} ${mode}`).toMatchObject({ ok: false, code: "forbidden" });
      } finally {
        await unmask();
      }
    }
    expect(await openAdvancesFor(clerk(), partyId)).toMatchObject({ ok: true });
  });
});
