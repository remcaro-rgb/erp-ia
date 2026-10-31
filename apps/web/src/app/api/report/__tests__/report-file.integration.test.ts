import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupAccounting, postEntry, seedSmallLedger, type SmallLedger } from "../../../../../test-support/accounting-fixture";
import { seedAuthUser, type AuthFixture } from "../../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar, headers: async () => new Headers() }));
vi.mock("workflow/api", () => ({ start: vi.fn(async () => ({ runId: "test-run" })) }));

import { runProcess, setExportsStore } from "@erp/kernel";
import { MemoryFileStore } from "@erp/kernel/testing";
import { requireCaller } from "@/lib/auth/claims";
import { loginWithPassword } from "@/lib/auth/login";
import { processDeps } from "@/lib/server/runtime";
import { POST } from "../[id]/file/[action]/route";

// POST /api/report/:id/file/:action (accounting design §5.11, §10a.5) against the real stack: the exógena's XML of the
// balance format 1008 for a small ledger with one supplier balance, run as a member whose role holds the two processes.

const REPORT = "accounting.exogena";
const PROCESS = "accounting.report.exogena_xml";
const store = new MemoryFileStore();

let fixture: AuthFixture;
let other: AuthFixture;
let ledger: SmallLedger;
let party: string;
let companyId: string;

const call = (body: unknown, action = "xml", headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/report/${REPORT}/file/${action}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: REPORT, action }),
  });
const params = { year: 2026, format: "1008" };

beforeAll(async () => {
  processDeps();
  setExportsStore(store);
  fixture = await seedAuthUser({ role: "member" });
  other = await seedAuthUser({ role: "member" });
  const { sql } = fixture;
  companyId = fixture.companyIds[0]!;
  await sql`update kernel.companies set tax_id = '900373115-3', legal_name = 'Café del Norte S.A.S.' where id = ${companyId}`;
  ledger = await seedSmallLedger(fixture);
  // The member's role holds the report and its file process (grantAccounting grants the admin role; this fixture's user is a member).
  for (const key of ["module:core", "module:accounting"]) await sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, ${key}, 'manual')`;
  const [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  for (const id of ["accounting.report.exogena", PROCESS]) await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${id})`;

  // 1305 (Clientes) holds the balance of the supplier; the 1008 format maps concept 1315 to it.
  for (const [code, name] of [["13", "Deudores"], ["1305", "Clientes"], ["130505", "Clientes nacionales"]] as const) {
    const [row] = await sql<{ id: string }[]>`
      insert into accounting.accounts (company_id, code, name, nature, allows_movement) values (${companyId}, ${code}, ${name}, 'debit', ${code.length >= 6}) returning id`;
    ledger.accounts[code] = row!.id;
  }
  await sql`insert into accounting.fiscal_concept_mappings (company_id, format, concept, account_id) values (${companyId}, '1008', '1315', ${ledger.accounts["1305"]!})`;
  [{ id: party }] = await sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, check_digit, legal_name, department_code, municipality_code, dian_status)
    values (${companyId}, '{customer,supplier}', '1', '31', '900555666', '5', 'Proveedor Uno S.A.S.', '11', '11001', 'complete') returning id`;
  await postEntry(fixture, ledger, { date: "2026-10-05", debit: "130505", credit: "413595", amount: 8_000_000, description: "Saldo de cartera", partyId: party });

  const jar = new MemoryJar();
  state.jar = jar;
  await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
}, 120_000);

afterAll(async () => {
  setExportsStore(undefined);
  const { sql } = fixture;
  await cleanupAccounting(fixture);
  await sql`delete from kernel.sensitive_processes where company_id = ${companyId}`;
  await sql`delete from core.parties where company_id = ${companyId}`;
  await other.cleanup();
  await fixture.cleanup();
});

describe("report-file", () => {
  it("POST /api/report/accounting.exogena/file/xml stores the XML in the exports store and answers a signed link named Dmuisca_…xml", async () => {
    const response = await call({ params });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string; fileName: string };
    expect(body.fileName).toMatch(/^Dmuisca_001008\d{2}2026\.xml$/);
    expect(body.url).toContain(`${companyId}/report-files/`);
    expect(body.url).toContain(`ttl=600`);
    const stored = [...store.files.entries()];
    expect(stored).toHaveLength(1);
    const [path, file] = stored[0]!;
    expect(path.endsWith(`/${body.fileName}`)).toBe(true);
    expect(file.contentType).toBe("application/xml");
    // The bytes are exactly what the process writes.
    const written = (await runProcess(processDeps(), await requireCaller(), PROCESS, params)) as { xml: string };
    expect(new TextDecoder().decode(file.bytes)).toBe(written.xml);
    expect(written.xml).toContain("<Formato>1008</Formato>");
    expect(written.xml).toContain('nid="900555666"');
  });

  it("answers 404 for an unknown report or action, 400 for parameters the report refuses and 403 for a foreign company header", async () => {
    expect((await call({ params }, "pdf")).status).toBe(404);
    expect((await call({ params: { year: "x" } })).status).toBe(400);
    expect((await call({ params: {} })).status).toBe(400);
    expect((await call({ params }, "xml", { "x-company-id": randomUUID() })).status).toBe(403);
    expect(store.files.size).toBe(1);
  });

  it("raised exogena_xml asks for step-up: 401 step_up_required without a fresh code, 200 with one bound to the caller", async () => {
    const { sql } = fixture;
    await sql`insert into kernel.sensitive_processes (company_id, process_id, mode) values (${companyId}, ${PROCESS}, 'self_2fa')`;
    const before = store.files.size;
    const asked = await call({ params });
    expect(asked.status).toBe(401);
    expect(await asked.json()).toMatchObject({ code: "step_up_required" });
    expect(store.files.size).toBe(before);

    // A verification of another user does not open it.
    const foreign = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${other.userId}, ${companyId}, ${foreign})`;
    expect((await call({ params, stepUpToken: foreign })).status).toBe(401);
    expect(store.files.size).toBe(before);

    const token = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${fixture.userId}, ${companyId}, ${token})`;
    const granted = await call({ params, stepUpToken: token });
    expect(granted.status).toBe(200);
    expect(store.files.size).toBe(before + 1);
    await sql`delete from kernel.sensitive_processes where company_id = ${companyId}`;
  });

  it("a refused XML (unmapped account) answers 400 with the error list and stores nothing", async () => {
    // A balance on a mapped account with no party: the report lists it and the file is refused.
    await postEntry(fixture, ledger, { date: "2026-10-06", debit: "130505", credit: "413595", amount: 1_000, description: "Sin tercero" });
    const before = store.files.size;
    const refused = await call({ params });
    expect(refused.status).toBe(400);
    const body = (await refused.json()) as { code: string; details: string[] };
    expect(body.code).toBe("invalid_input");
    expect(body.details).toEqual([expect.stringMatching(/sin tercero.*130505/i)]);
    expect(store.files.size).toBe(before);
    // No rows for another format: refused with its reason, still nothing stored.
    const empty = await call({ params: { year: 2026, format: "1003" } });
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { details: string[] }).details).toEqual([expect.stringContaining("1003")]);
    expect(store.files.size).toBe(before);
  });

  it("a caller whose role lacks the process answers 403 and stores nothing", async () => {
    const { sql } = fixture;
    await sql`delete from kernel.process_permissions where company_id = ${companyId} and process_id = ${PROCESS}`;
    const before = store.files.size;
    expect((await call({ params })).status).toBe(403);
    expect(store.files.size).toBe(before);
  });
});


