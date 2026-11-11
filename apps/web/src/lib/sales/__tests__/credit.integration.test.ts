import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JwtClaims } from "@erp/kernel";
import { seedAuthUser, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { creditVisibleTo } from "@/lib/sales/credit";
import { processDeps } from "@/lib/server/runtime";

// A pedido's credit «Disponible» is summed from invoicing's published (unmasked) views, so it shows only to a caller who sees every amount
// it counts (final review I-2, rule 14): the credit limit, the invoice consult and the invoices' money fields. A role with the invoice total
// masked would otherwise read what the customer owes as the difference. It also needs `sales.order.reassign`, so `sales.v_orders` (owner
// scope, 0139) holds every salesperson's firm orders and the figure agrees with the approval check (review F-4.2).

let member: AuthFixture;
let companyId: string;
let roleId: string;

const claims = (): JwtClaims => ({ sub: member.userId, tenant_id: member.tenantId, company_ids: [companyId], active_company_id: companyId, role_ids: [roleId], locale: "es-419" });

beforeAll(async () => {
  member = await seedAuthUser({ role: "member" });
  companyId = member.companyIds[0]!;
  roleId = (await member.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`)[0]!.id;
  for (const key of ["module:core", "module:inventory", "module:crm", "module:sales", "module:invoicing"]) {
    await member.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${member.tenantId}, ${key}, 'manual') on conflict do nothing`;
  }
  for (const process of ["invoicing.invoice.consult", "sales.customer_terms.consult", "sales.order.reassign"]) {
    await member.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, ${process}) on conflict do nothing`;
  }
});

afterAll(async () => {
  await member.sql`delete from kernel.field_permissions where company_id = ${companyId}`;
  await member.sql`delete from kernel.process_permissions where company_id = ${companyId}`;
  await member.sql`delete from kernel.tenant_entitlements where tenant_id = ${member.tenantId}`;
  await member.cleanup();
});

const mask = (entity: string, field: string, mode: "masked" | "hidden") => member.sql`
  insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${companyId}, ${roleId}, ${entity}, ${field}, ${mode})
  on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
const unmask = () => member.sql`delete from kernel.field_permissions where company_id = ${companyId} and role_id = ${roleId}`;

describe("creditVisibleTo (the pedido's credit Disponible)", () => {
  it("shows to a role that consults invoices and sees the limit and the invoices' amounts", async () => {
    expect(await creditVisibleTo(processDeps(), claims())).toBe(true);
  });

  it("hides when the invoice total, a balance field or the lines' total is masked or hidden for the role", async () => {
    for (const [entity, field, mode] of [
      ["invoicing.invoice", "total", "masked"],
      ["invoicing.invoice", "total_company", "hidden"],
      ["invoicing.invoice", "paid_amount", "masked"],
      ["invoicing.invoice", "credited_amount", "masked"],
      ["invoicing.invoice", "debited_amount", "masked"],
      ["invoicing.invoice_line", "total", "masked"],
      ["sales.customer_terms", "credit_limit", "masked"],
    ] as const) {
      await mask(entity, field, mode);
      try {
        expect(await creditVisibleTo(processDeps(), claims()), `${entity}.${field} ${mode}`).toBe(false);
      } finally {
        await unmask();
      }
    }
    expect(await creditVisibleTo(processDeps(), claims())).toBe(true);
  });

  it("hides from a role that may not consult invoices", async () => {
    await member.sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${roleId} and process_id = 'invoicing.invoice.consult'`;
    try {
      expect(await creditVisibleTo(processDeps(), claims())).toBe(false);
    } finally {
      await member.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'invoicing.invoice.consult') on conflict do nothing`;
    }
  });

  it("hides from a salesperson who may not run sales.order.reassign: v_orders then leaves out other salespeople's orders (review F-4.2)", async () => {
    await member.sql`delete from kernel.process_permissions where company_id = ${companyId} and role_id = ${roleId} and process_id = 'sales.order.reassign'`;
    try {
      expect(await creditVisibleTo(processDeps(), claims())).toBe(false);
    } finally {
      await member.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'sales.order.reassign') on conflict do nothing`;
    }
  });
});
