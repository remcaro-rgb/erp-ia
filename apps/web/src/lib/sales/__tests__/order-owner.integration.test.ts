import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims, type JwtClaims, type Tx } from "@erp/kernel";
import { seedAuthUser, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { activeMembers, memberNames, orderOwners, readableOrderIds, unreadableOrderIds } from "@/lib/sales/order-owner";
import { processDeps } from "@/lib/server/runtime";

// What the order frames read about who owns a pedido (plan 2B Task 39, R39-8, R39-13): the members' names as the caller's masked
// kernel.v_users shows them, the pickers of «Cambiar vendedor» (active members only), which pedidos the caller can read at all
// (a reference to one it cannot read is «Pedido no disponible») and sales.v_order_owners (the owner of each readable pedido).

let admin: AuthFixture;
let member: AuthFixture;
let companyId: string;
let adminRole: string;
let memberRole: string;
let orderMine: string;
let orderOther: string;
let orderNobody: string;
let lineMine: string;
let lineOther: string;
let seq = 0;

const claims = (userId: string, roles: string[]): JwtClaims => ({ sub: userId, tenant_id: admin.tenantId, company_ids: [companyId], active_company_id: companyId, role_ids: roles, locale: "es-419" });

beforeAll(async () => {
  admin = await seedAuthUser({ role: "admin" });
  companyId = admin.companyIds[0]!;
  adminRole = (await admin.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`)[0]!.id;
  memberRole = (await admin.sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${companyId}, 'Vendedor') returning id`)[0]!.id;
  // A second member of the same company (a plain role), and a third one that left.
  member = await seedAuthUser({ role: "member" });
  const [membership] = await admin.sql<{ id: string }[]>`insert into kernel.memberships(user_id, company_id) values (${member.userId}, ${companyId}) returning id`;
  await admin.sql`insert into kernel.membership_roles(membership_id, role_id) values (${membership!.id}, ${memberRole})`;
  await admin.sql`update kernel.users set full_name = 'Ana Vendedora' where id = ${member.userId}`;
  await admin.sql`update kernel.users set full_name = 'Laura Gerente' where id = ${admin.userId}`;
  for (const key of ["module:core", "module:inventory", "module:crm", "module:sales"]) {
    await admin.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${admin.tenantId}, ${key}, 'manual') on conflict do nothing`;
  }
  // Pedidos written straight (the table's insert policy is the process gate; the fixture connection is the owner of the schema).
  const party = { id: randomUUID() };
  const insert = async (owner: string | null) =>
    (await admin.sql<{ id: string }[]>`
      insert into sales.orders(company_id, seq, party_id, issue_date, requires_approval, posts, owner_id)
      values (${companyId}, ${++seq}, ${party.id}, current_date, false, false, ${owner}) returning id`)[0]!.id;
  orderMine = await insert(member.userId);
  orderOther = await insert(admin.userId);
  orderNobody = await insert(null);
  const line = async (orderId: string) =>
    (await admin.sql<{ id: string }[]>`
      insert into sales.order_lines(company_id, seq, order_id, line_no, product_id, qty, unit_price)
      values (${companyId}, ${++seq}, ${orderId}, 1, ${randomUUID()}, 1, 1000) returning id`)[0]!.id;
  lineMine = await line(orderMine);
  lineOther = await line(orderOther);
});

afterAll(async () => {
  await admin.sql`delete from sales.order_lines where company_id = ${companyId}`;
  await admin.sql`delete from sales.orders where company_id = ${companyId}`;
  await admin.sql`delete from core.entity_sequences where company_id = ${companyId}`;
  await admin.sql`delete from kernel.tenant_entitlements where tenant_id = ${admin.tenantId}`;
  await admin.sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${member.userId})`;
  await admin.sql`delete from kernel.memberships where user_id = ${member.userId} and company_id = ${companyId}`;
  await admin.sql`delete from kernel.roles where id = ${memberRole}`;
  await member.cleanup();
  await admin.cleanup();
});

const as = <T>(userId: string, roles: string[], run: (tx: Tx) => Promise<T>) => withClaims(processDeps().sql, claims(userId, roles), run);

describe("members' names and the picker", () => {
  it("names the members of the company as the caller sees them", async () => {
    const names = await as(member.userId, [memberRole], (tx) => memberNames(tx, [member.userId, admin.userId, "00000000-0000-4000-8000-000000000000"]));
    expect(names.get(member.userId)).toBe("Ana Vendedora");
    expect(names.get(admin.userId)).toBe("Laura Gerente");
    expect(names.has("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("offers the active members, by name, and leaves out a deactivated one", async () => {
    const all = await as(admin.userId, [adminRole], (tx) => activeMembers(tx));
    expect(all.map((m) => m.name).sort()).toEqual(["Ana Vendedora", "Laura Gerente"]);
    await admin.sql`update kernel.memberships set is_active = false where user_id = ${member.userId} and company_id = ${companyId}`;
    try {
      expect((await as(admin.userId, [adminRole], (tx) => activeMembers(tx))).map((m) => m.name)).toEqual(["Laura Gerente"]);
    } finally {
      await admin.sql`update kernel.memberships set is_active = true where user_id = ${member.userId} and company_id = ${companyId}`;
    }
  });
});

describe("which pedidos a caller can read and who owns them", () => {
  it("a salesperson reads only their own pedido: another's id (and a pedido with no owner) is not readable", async () => {
    const ids = [orderMine, orderOther, orderNobody];
    const readable = await as(member.userId, [memberRole], (tx) => readableOrderIds(tx, ids));
    expect([...readable]).toEqual([orderMine]);
    const owners = await as(member.userId, [memberRole], (tx) => orderOwners(tx, ids));
    expect([...owners.entries()]).toEqual([[orderMine, member.userId]]);
  });

  it("a company admin (the all-orders permission) reads every pedido and each owner, the empty one included", async () => {
    const ids = [orderMine, orderOther, orderNobody];
    expect([...(await as(admin.userId, [adminRole], (tx) => readableOrderIds(tx, ids)))].sort()).toEqual([...ids].sort());
    const owners = await as(admin.userId, [adminRole], (tx) => orderOwners(tx, ids));
    expect(owners.get(orderMine)).toBe(member.userId);
    expect(owners.get(orderOther)).toBe(admin.userId);
    expect(owners.get(orderNobody)).toBeNull();
  });

  it("answers nothing for an empty list", async () => {
    expect((await as(admin.userId, [adminRole], (tx) => readableOrderIds(tx, []))).size).toBe(0);
    expect((await as(admin.userId, [adminRole], (tx) => orderOwners(tx, []))).size).toBe(0);
  });
});

describe("the pedidos a version history names", () => {
  it("lists the ones the caller cannot read, from the header and the lines", async () => {
    const snapshots = [
      { header: { order_id: orderOther }, lines: [{ order_id: orderMine }, { qty: 1 }] },
      { header: { order_id: orderNobody }, lines: [] },
    ];
    expect([...(await as(member.userId, [memberRole], (tx) => unreadableOrderIds(tx, snapshots)))].sort()).toEqual([orderNobody, orderOther].sort());
    expect((await as(admin.userId, [adminRole], (tx) => unreadableOrderIds(tx, snapshots))).size).toBe(0);
    expect((await as(admin.userId, [adminRole], (tx) => unreadableOrderIds(tx, null))).size).toBe(0);
  });

  it("lists the pedido lines (order_line_id of entrega and factura lines) whose pedido the caller cannot read (final review m1)", async () => {
    const snapshots = [{ header: { order_id: orderMine }, lines: [{ order_line_id: lineMine }, { order_line_id: lineOther }] }];
    expect([...(await as(member.userId, [memberRole], (tx) => unreadableOrderIds(tx, snapshots)))]).toEqual([lineOther]);
    expect((await as(admin.userId, [adminRole], (tx) => unreadableOrderIds(tx, snapshots))).size).toBe(0);
  });
});
