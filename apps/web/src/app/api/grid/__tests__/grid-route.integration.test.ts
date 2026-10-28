import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAuthUser, type AuthFixture } from "../../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));

import { loginWithPassword } from "@/lib/auth/login";
import { POST } from "../[entity]/route";

// POST /api/grid/:entity (design §9, rules 14 and 20) against the real stack: a cashier whose role sees parties
// but has `credit_limit` hidden and `document_number` masked, signed in through Supabase Auth.

let fixture: AuthFixture;
let other: AuthFixture;
let roleId: string;

const call = (entity: string, body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/grid/${entity}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ entity }),
  });

const base = { filters: [], sort: [], page: 1, pageSize: 25 };

beforeAll(async () => {
  fixture = await seedAuthUser({ role: "member" });
  other = await seedAuthUser({ role: "member" });
  const companyId = fixture.companyIds[0]!;
  const { sql } = fixture;
  await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
  [{ id: roleId }] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'core.party.consult')`;
  await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values
    (${companyId}, ${roleId}, 'core.party', 'credit_limit', 'hidden'),
    (${companyId}, ${roleId}, 'core.party', 'document_number', 'masked')`;
  for (const [name, doc, kind, limit] of [
    ["Almacenes Éxito S.A.", "890900608", ["customer"], 5_000_000],
    ["Café del Norte S.A.S.", "900373115", ["customer", "supplier"], 1_000_000],
    ["Tostadora Pérez", "1020304050", ["supplier"], 0],
  ] as const) {
    await sql`insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, credit_limit, dian_status)
              values (${companyId}, ${kind as unknown as string[]}, '1', '31', ${doc}, ${name}, ${limit}, 'complete')`;
  }
  const jar = new MemoryJar();
  state.jar = jar;
  await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
});

afterAll(async () => {
  const { sql } = fixture;
  await sql`delete from core.parties where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from core.entity_sequences where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.field_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.process_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
  await sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
  await fixture.cleanup();
  await other.cleanup();
});

describe("grid-route", () => {
  it("as cashier with credit_limit hidden, rows have credit_limit: null", async () => {
    const response = await call("core.party", { ...base, sort: [{ field: "legal_name", dir: "asc" }] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Record<string, unknown>[]; total: number };
    expect(body.total).toBe(3);
    expect(body.rows.map((r) => r.legal_name)).toEqual(["Almacenes Éxito S.A.", "Café del Norte S.A.S.", "Tostadora Pérez"]);
    for (const row of body.rows) {
      expect(row.credit_limit).toBeNull();
      expect(row.document_number).toBeNull();
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("filters, joins with O, searches and pages on the server", async () => {
    const filtered = await call("core.party", {
      ...base,
      filters: [
        { field: "legal_name", op: "contains", value: "éxito" },
        { field: "kind", op: "eq", value: "supplier", join: "or" },
      ],
      sort: [{ field: "legal_name", dir: "desc" }],
      pageSize: 2,
      page: 1,
    });
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as { rows: { legal_name: string }[]; total: number };
    expect(body.total).toBe(3);
    expect(body.rows.map((r) => r.legal_name)).toEqual(["Tostadora Pérez", "Café del Norte S.A.S."]);

    const searched = await call("core.party", { ...base, search: "norte" });
    expect(((await searched.json()) as { rows: { legal_name: string }[] }).rows.map((r) => r.legal_name)).toEqual(["Café del Norte S.A.S."]);
    // The masked document number is not searched: its digits find nothing.
    const masked = await call("core.party", { ...base, search: "900373115" });
    expect(((await masked.json()) as { total: number }).total).toBe(0);
  });

  it("sorts, groups and aggregates a datetime without a filter on it (no unused time-zone parameter)", async () => {
    const response = await call("core.party", { ...base, sort: [{ field: "created_at", dir: "desc" }], groupBy: "created_at", aggregates: [{ field: "created_at", fn: "min" }, { field: "created_at", fn: "max" }] });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { total: number; aggregates: Record<string, string> };
    expect(body.total).toBe(3);
    expect(Object.keys(body.aggregates).sort()).toEqual(["max:created_at", "min:created_at"]);
    const filtered = await call("core.party", { ...base, filters: [{ field: "created_at", op: "gt", value: "2000-01-01" }], sort: [{ field: "created_at", dir: "asc" }] });
    expect(((await filtered.json()) as { total: number }).total).toBe(3);
  });

  it("filter on hidden field returns 403", async () => {
    const hidden = await call("core.party", { ...base, filters: [{ field: "credit_limit", op: "gt", value: 1 }] });
    expect(hidden.status).toBe(403);
    expect(await hidden.json()).toMatchObject({ code: "field_hidden" });
    // A masked field never filters or sorts either.
    expect((await call("core.party", { ...base, sort: [{ field: "document_number", dir: "asc" }] })).status).toBe(403);
    expect((await call("core.party", { ...base, filters: [{ field: "document_number", op: "eq", value: "900373115" }] })).status).toBe(403);
  });

  it("company header must be in caller's claims", async () => {
    const foreign = await call("core.party", base, { "x-company-id": other.companyIds[0]! });
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toMatchObject({ code: "forbidden" });
    // The active company may be confirmed; it is never switched by a header.
    expect((await call("core.party", base, { "x-company-id": fixture.companyIds[0]! })).status).toBe(200);
  });

  it("400 on an invalid state, 404 on an unknown entity, 403 without the module or the consult permission", async () => {
    expect((await call("core.party", { ...base, pageSize: 10_000 })).status).toBe(400);
    expect((await call("core.party", { ...base, search: "x".repeat(70_000) }, { "content-length": "70100" })).status).toBe(413);
    expect((await call("core.party", { ...base, filters: [{ field: "legal_name", op: "gt", value: "a" }] })).status).toBe(400);
    expect((await call("core.nope", base)).status).toBe(404);
    // The role may not consult products.
    expect((await call("core.product", base)).status).toBe(403);
    await fixture.sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    try {
      const response = await call("core.party", base);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "not_entitled" });
    } finally {
      await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    }
  });

  it("a grid needs the entity's own consult: a role allowed categories does not read price lists, their items or units", async () => {
    const companyId = fixture.companyIds[0]!;
    await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId}, 'core.category.consult')`;
    try {
      expect((await call("core.product_category", base)).status).toBe(200);
      for (const entity of ["core.price_list_item", "core.price_list", "core.uom", "core.product"]) {
        const response = await call(entity, base);
        expect(response.status, entity).toBe(403);
        expect(await response.json()).toMatchObject({ code: "forbidden" });
      }
    } finally {
      await fixture.sql`delete from kernel.process_permissions where role_id = ${roleId} and process_id = 'core.category.consult'`;
    }
  });

  it("401 without a session", async () => {
    const jar = state.jar;
    state.jar = new MemoryJar();
    try {
      expect((await call("core.party", base)).status).toBe(401);
    } finally {
      state.jar = jar;
    }
  });
});
