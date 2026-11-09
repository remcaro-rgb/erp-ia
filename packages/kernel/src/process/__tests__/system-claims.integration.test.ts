import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { isSystemSub, withClaims, type JwtClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { SYSTEM_USER_ID } from "../../events/consumers";
import { Registry } from "../../registry";
import { defineProcess } from "../define";
import type { Caller } from "../context";
import { runProcess } from "../run";
import { syncRegistry } from "../../admin/sync";

// Plan 2B Task 52.3 (owner item 100, ruling R52-4): the kernel's system user (`SYSTEM_USER_ID`) holding the company's system admin
// role is the actor of event consumers and scheduled checks only. runProcess refuses those claims for any other origin
// (`forbidden`, details.reason `system_claims_refused`, audited as a denial; counted, not audited, in the assistant's preflight dry run),
// and withClaims refuses them unless its caller passes `{ allowSystem: true }`. Defence in depth: user claims come from a verified JWT.

let handlerRuns = 0;

const probe = defineProcess({
  id: "test.sysclaims.touch",
  module: "test",
  kind: "update",
  description: "proceso de prueba de las credenciales del sistema",
  input: z.object({ n: z.number() }),
  output: z.object({ n: z.number(), actor: z.string() }),
  handler: async (ctx, input) => {
    handlerRuns += 1;
    return { n: input.n + 1, actor: ctx.userId };
  },
});

describe("runProcess and withClaims refuse the system user's claims outside event and scheduler origins", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let system: JwtClaims;

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 1 });
    companyId = seed.companies[0]!.id;
    registry = new Registry();
    registry.registerProcess(probe);
    await syncRegistry(sql, registry);
    system = { sub: SYSTEM_USER_ID, tenant_id: seed.tenantId, company_ids: [companyId], active_company_id: companyId, role_ids: [seed.companies[0]!.adminRoleId], locale: "es-419" };
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  for (const origin of ["ui", "agent", "api"] as const) {
    it(`origin ${origin} with the system sub is refused before the handler, with one denial audit row`, async () => {
      const chainId = randomUUID();
      const before = handlerRuns;
      const caller: Caller = { claims: system, origin, chainId };
      await expect(runProcess({ sql, registry }, caller, probe.id, { n: 1 })).rejects.toMatchObject({
        code: "forbidden",
        stage: "gate",
        details: { reason: "system_claims_refused" },
      });
      expect(handlerRuns).toBe(before);
      const audits = await sql<{ action: string; actor_user_id: string; origin: string; input: { code: string } }[]>`
        select action, actor_user_id, origin, input from kernel.audit_log where chain_id = ${chainId}`;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "denied", actor_user_id: SYSTEM_USER_ID, origin, input: { code: "forbidden" } });
    });
  }

  it("in the assistant's preflight dry run the refusal is counted, not audited", async () => {
    const chainId = randomUUID();
    const count = async () => {
      const [row] = await sql<{ count: string | null }[]>`
        select sum(count)::text as count from kernel.dry_run_denial_counters
        where company_id = ${companyId} and process_id = ${probe.id} and code = 'forbidden'`;
      return Number(row?.count ?? 0);
    };
    const before = await count();
    await expect(
      runProcess({ sql, registry }, { claims: system, origin: "agent", chainId }, probe.id, { n: 1 }, { dryRun: true, preflight: "assistant" }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "system_claims_refused" } });
    expect(await sql`select 1 from kernel.audit_log where chain_id = ${chainId}`).toHaveLength(0);
    expect(await count()).toBe(before + 1);
  });

  for (const origin of ["event", "scheduler"] as const) {
    it(`origin ${origin} with the system sub runs as the system user`, async () => {
      const chainId = randomUUID();
      await expect(runProcess({ sql, registry }, { claims: system, origin, chainId }, probe.id, { n: 1 })).resolves.toEqual({ n: 2, actor: SYSTEM_USER_ID });
      const audits = await sql`select action, actor_user_id, origin from kernel.audit_log where chain_id = ${chainId}`;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: "update", actor_user_id: SYSTEM_USER_ID, origin });
    });
  }

  it("a real user's claims still run from the ui", async () => {
    const caller: Caller = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    await expect(runProcess({ sql, registry }, caller, probe.id, { n: 3 })).resolves.toMatchObject({ n: 4 });
  });

  // Fix round 1 (review I-1): Postgres reads the sub as a uuid and accepts other spellings of the nil UUID; each is the system user.
  const SPELLINGS = [
    "{00000000-0000-0000-0000-000000000000}",
    "{00000000000000000000000000000000}",
    "00000000000000000000000000000000",
    "0000-0000-0000-0000-0000-0000-0000-0000",
  ];

  it("Postgres reads every listed spelling as the nil uuid (the premise of the cases below)", async () => {
    for (const sub of SPELLINGS) {
      const [row] = await sql<{ nil: boolean }[]>`select ${sub}::uuid = ${SYSTEM_USER_ID}::uuid as nil`;
      expect(row).toEqual({ nil: true });
    }
  });

  for (const sub of SPELLINGS) {
    for (const origin of ["ui", "agent", "api"] as const) {
      it(`origin ${origin} with the system sub spelled ${sub} is refused, with one denial audit row`, async () => {
        const chainId = randomUUID();
        const before = handlerRuns;
        await expect(runProcess({ sql, registry }, { claims: { ...system, sub }, origin, chainId }, probe.id, { n: 1 })).rejects.toMatchObject({
          code: "forbidden",
          stage: "gate",
          details: { reason: "system_claims_refused" },
        });
        expect(handlerRuns).toBe(before);
        const audits = await sql`select action, actor_user_id, origin from kernel.audit_log where chain_id = ${chainId}`;
        expect(audits).toHaveLength(1);
        expect(audits[0]).toMatchObject({ action: "denied", actor_user_id: SYSTEM_USER_ID, origin });
      });
    }
    for (const origin of ["event", "scheduler"] as const) {
      it(`origin ${origin} with the system sub spelled ${sub} runs`, async () => {
        await expect(runProcess({ sql, registry }, { claims: { ...system, sub }, origin }, probe.id, { n: 1 })).resolves.toMatchObject({ n: 2 });
      });
    }
    it(`withClaims refuses the system sub spelled ${sub} by default and runs it with allowSystem`, async () => {
      await expect(withClaims(sql, { ...system, sub }, (tx) => tx`select 1`)).rejects.toMatchObject({ code: "forbidden", details: { reason: "system_claims_refused" } });
      const [row] = await withClaims(sql, { ...system, sub }, (tx) => tx<{ uid: string }[]>`select auth.uid()::text as uid`, { allowSystem: true });
      expect(row).toEqual({ uid: SYSTEM_USER_ID });
    });
  }

  it("isSystemSub knows every spelling and no real user id", () => {
    for (const sub of [SYSTEM_USER_ID, ...SPELLINGS]) expect(isSystemSub(sub)).toBe(true);
    expect(isSystemSub(seed.users.both!)).toBe(false);
    expect(isSystemSub("00000000-0000-0000-0000-000000000001")).toBe(false);
  });

  it("withClaims refuses the system sub by default and runs it with allowSystem", async () => {
    await expect(withClaims(sql, system, (tx) => tx`select 1`)).rejects.toMatchObject({ code: "forbidden", details: { reason: "system_claims_refused" } });
    const [row] = await withClaims(sql, system, (tx) => tx<{ uid: string }[]>`select auth.uid()::text as uid`, { allowSystem: true });
    expect(row).toEqual({ uid: SYSTEM_USER_ID });
    const user = seed.claimsFor(seed.users.both, companyId);
    const [own] = await withClaims(sql, user, (tx) => tx<{ uid: string }[]>`select auth.uid()::text as uid`);
    expect(own).toEqual({ uid: seed.users.both });
  });
});
