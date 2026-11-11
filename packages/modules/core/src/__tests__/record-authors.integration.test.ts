import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess, withClaims, type Caller } from "@erp/kernel";
import { CORE_PROCESS_IDS, coreHarness, exito, type CoreHarness } from "./helpers";

// The record footer's «Creado en … por …» / «Modificado en … por …» (Phase 2A.5 Task 15): kernel.record_authors (0050) names who
// created and last changed a maestro or documento the caller may read; nothing for a record they may not read or of another company.
describe("kernel.record_authors (Task 15)", () => {
  let h: CoreHarness;
  let clerk: Caller;
  let clerkId: string;
  const authors = (caller: Caller, entity: string, id: string) =>
    withClaims(h.sql, caller.claims, (tx) => tx<{ created_by_name: string | null; updated_by_name: string | null }[]>`select * from kernel.record_authors(${entity}, ${id}::uuid)`);

  beforeAll(async () => {
    h = await coreHarness({ users: [{ name: "clerk", companies: [0], role: "member" }] });
    clerkId = h.seed.users.clerk!;
    await h.grantAll(h.companyId, h.seed.companies[0]!.memberRoleId, CORE_PROCESS_IDS);
    clerk = { claims: h.seed.claimsFor(clerkId, h.companyId), origin: "ui" };
  });
  afterAll(async () => {
    await h.sql`delete from kernel.record_access where company_id = ${h.companyId}`;
    await h.cleanup();
  });

  it("names the creator and the last editor of a party the caller may read", async () => {
    const id = (await runProcess(h.deps, h.admin, "core.party.create", { ...exito, documentNumber: "860002964" })).id as string;
    await h.sql`update kernel.users set full_name = 'Laura Mendoza' where id = ${h.seed.users.both!}`;
    await h.sql`update kernel.users set full_name = 'Andrés Gómez' where id = ${clerkId}`;
    await runProcess(h.deps, clerk, "core.party.update", { id, tradeName: "Éxito Norte" });
    expect(await authors(clerk, "core.party", id)).toEqual([{ created_by_name: "Laura Mendoza", updated_by_name: "Andrés Gómez" }]);
  });

  it("answers nothing for a record the caller may not read, an unknown entity or an unknown id", async () => {
    const id = (await runProcess(h.deps, h.admin, "core.party.create", { ...exito, documentNumber: "890900609" })).id as string;
    await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_user_id, can_read) values (${h.companyId}, 'core.party', ${id}, ${h.seed.users.both!}, true)`;
    expect(await authors(clerk, "core.party", id)).toEqual([]);
    expect(await authors(clerk, "core.nothing", id)).toEqual([]);
    expect(await authors(clerk, "core.party", "01923456-0000-7000-8000-000000000000")).toEqual([]);
  });
});
