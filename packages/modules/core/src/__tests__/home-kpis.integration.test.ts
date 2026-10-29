import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess, type Caller, type Kpi } from "@erp/kernel";
import { attachFile, coreHarness, exito, supplier, type CoreHarness } from "./helpers";

// The core module's cards on the home screen (Task 20): parties and products, counted through the published views as the
// caller, so the party scope and the role matrix decide what each person sees (rules 13 and 14).

const cafe = {
  sku: "CAF-500",
  description: "Café tostado molido 500 g",
  kind: "good",
  idScheme: "010",
  standardCode: "7702001005000",
  uomCode: "94",
  ivaRate: "5",
  otherTaxes: [],
  listPrice: 28500,
  isFreeSample: false,
  standardCost: 16200,
  trackStock: true,
};

describe("core home KPIs", () => {
  let h: CoreHarness;
  let admin: Caller;
  let vendedor: Caller;
  let partyId: string;

  const kpis = async (caller: Caller) => ((await runProcess(h.deps, caller, "kernel.home.kpis", {})) as { kpis: Kpi[] }).kpis;
  const kpi = async (caller: Caller, id: string) => (await kpis(caller)).find((k) => k.id === id);
  const withoutSeries = (card: Kpi | undefined) => {
    const rest: Partial<Kpi> = { ...card! };
    delete rest.series;
    return rest;
  };
  /** Moves a row's creation to `daysAgo` days back at `time`, on the company's calendar (Bogotá); the touch trigger would keep the old one. */
  const createdAt = (table: "parties" | "products", id: string, daysAgo: number, time: string) =>
    h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update ${tx(`core.${table}`)} set created_at = (((now() at time zone 'America/Bogota')::date - ${daysAgo}::int + ${time}::time) at time zone 'America/Bogota') where id = ${id}`;
    });
  /** The 14 expected days: `byDaysAgo[n]` rows `n` days back, today last. */
  const days = (byDaysAgo: Record<number, number>) => Array.from({ length: 14 }, (_, i) => byDaysAgo[13 - i] ?? 0);

  beforeAll(async () => {
    h = await coreHarness({ users: [{ name: "vendedor", companies: [0], role: "member" }] });
    admin = h.admin;
    const company = h.seed.companies[0]!;
    await h.grantAll(company.id, company.adminRoleId, ["kernel.home.kpis"]);
    // A sales role that only sees customers and may consult parties, but not products.
    await h.sql`update kernel.roles set name = 'vendedor', party_scope = 'clientes' where id = ${company.memberRoleId}`;
    await h.grantAll(company.id, company.memberRoleId, ["kernel.home.kpis", "core.party.consult"]);
    vendedor = { claims: h.seed.claimsFor(h.seed.users.vendedor!, h.companyId), origin: "ui" };

    partyId = (await runProcess(h.deps, admin, "core.party.create", exito)).id;
    await runProcess(h.deps, admin, "core.party.create", supplier("800197268"));
    await runProcess(h.deps, admin, "core.product.create", cafe);
    await runProcess(h.deps, admin, "core.product.create", { ...cafe, sku: "CAF-250", standardCode: undefined });
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("counts the active parties of the company and how many cannot be invoiced yet", async () => {
    expect(withoutSeries(await kpi(admin, "core.parties"))).toEqual({
      id: "core.parties",
      label: "home.kpi.core_parties.label",
      value: 2,
      unit: "count",
      progress: 1,
      detail: { key: "home.kpi.core_parties.detail", params: { total: 2, not_ready: 2 } },
    });
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await attachFile(h.sql, { tenantId: h.seed.tenantId, companyId: h.companyId, entity: "core.party", recordId: partyId, tag });
    }
    expect((await kpi(admin, "core.parties"))!.detail!.params).toMatchObject({ total: 2, not_ready: 1 });
  });

  describe("trend", () => {
    let supplierId: string;
    let productIds: string[];
    beforeAll(async () => {
      supplierId = (await h.sql<{ id: string }[]>`select id from core.parties where company_id = ${h.companyId} and id <> ${partyId}`)[0]!.id;
      productIds = (await h.sql<{ id: string }[]>`select id from core.products where company_id = ${h.companyId} order by seq`).map((r) => r.id);
      // The customer joined two days ago; the supplier at 23:30 yesterday in Bogotá (already tomorrow in UTC).
      await createdAt("parties", partyId, 2, "10:00");
      await createdAt("parties", supplierId, 1, "23:30");
      await createdAt("products", productIds[0]!, 3, "08:00");
    });

    it("is 14 daily counts of new parties, oldest first, by the company's days", async () => {
      const card = await kpi(admin, "core.parties");
      expect(card!.series).toHaveLength(14);
      expect(card!.series).toEqual(days({ 2: 1, 1: 1 }));
      // The card's number is what it was: the total, not the window.
      expect(card!.value).toBe(2);
    });

    it("counts new products the same way (one three days ago, one today)", async () => {
      expect((await kpi(admin, "core.products"))!.series).toEqual(days({ 3: 1, 0: 1 }));
    });

    it("is computed as the caller: the customers-only role gets the customer's day, not the supplier's", async () => {
      expect((await kpi(vendedor, "core.parties"))!.series).toEqual(days({ 2: 1 }));
    });

    it("leaves out what happened before the window", async () => {
      await createdAt("parties", supplierId, 14, "12:00");
      try {
        expect((await kpi(admin, "core.parties"))!.series).toEqual(days({ 2: 1 }));
      } finally {
        await createdAt("parties", supplierId, 1, "23:30");
      }
    });

    afterAll(async () => {
      await createdAt("parties", partyId, 0, "12:00");
      await createdAt("parties", supplierId, 0, "12:00");
    });
  });

  it("counts the products and how many are not invoice ready", async () => {
    expect(withoutSeries(await kpi(admin, "core.products"))).toEqual({
      id: "core.products",
      label: "home.kpi.core_products.label",
      value: 2,
      unit: "count",
      detail: { key: "home.kpi.core_products.detail", params: { not_ready: 1 } },
    });
  });

  it("an inactive party leaves the active count and the share bar follows", async () => {
    await h.sql`update core.parties set is_active = false where id = ${partyId}`;
    const card = await kpi(admin, "core.parties");
    expect(card).toMatchObject({ value: 1, progress: 0.5 });
    expect(card!.detail!.params).toMatchObject({ total: 2 });
    await h.sql`update core.parties set is_active = true where id = ${partyId}`;
  });

  it("is computed within the caller's party scope and process permissions", async () => {
    // The customers-only role counts one party, and has no products card: it may not consult products.
    expect(await kpi(vendedor, "core.parties")).toMatchObject({ value: 1, detail: { params: { total: 1 } } });
    expect(await kpi(vendedor, "core.products")).toBeUndefined();
  });

  it("a hidden field never fakes a number: with is_active masked the card counts everyone", async () => {
    const company = h.seed.companies[0]!;
    await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${company.id}, ${company.memberRoleId}, 'core.party', 'is_active', 'hidden')`;
    try {
      expect(await kpi(vendedor, "core.parties")).toMatchObject({ label: "home.kpi.core_parties.label_total", value: 1 });
    } finally {
      await h.sql`delete from kernel.field_permissions where company_id = ${company.id} and field = 'is_active'`;
    }
  });
});
