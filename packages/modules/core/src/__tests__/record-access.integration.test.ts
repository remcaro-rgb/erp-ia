import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { CORE_PROCESS_IDS, coreHarness, exito, type CoreHarness } from "./helpers";

// Record-level access on the core maestros (spec 2026-11-02 §9.1; Task 9 review I4): the processes that change a party's or a
// category's data under another name than `<entity>.<verb>` need the modify right on that record too.
describe("core record-level access (Task 9)", () => {
  let h: CoreHarness;
  let clerk: Caller;
  let clerkId: string;

  const narrow = async (entity: string, recordId: string, rights: { modify?: boolean; delete?: boolean } = {}) => {
    await h.sql`delete from kernel.record_access where company_id = ${h.companyId} and record_id = ${recordId}`;
    await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_user_id, can_read, can_modify, can_delete)
      values (${h.companyId}, ${entity}, ${recordId}, ${clerkId}, true, ${rights.modify ?? false}, ${rights.delete ?? false})`;
  };
  const refusal = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e);

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

  it("a contact is written only with the modify right on its party", async () => {
    const partyId = (await runProcess(h.deps, h.admin, "core.party.create", exito)).id as string;
    const { id: contactId } = (await runProcess(h.deps, clerk, "core.contact.create", { partyId, name: "Ana" })) as { id: string };
    await narrow("core.party", partyId);
    const forbidden = { code: "record_forbidden", details: { entity: "core.party", recordId: partyId, right: "modify" } };
    expect(await refusal(runProcess(h.deps, clerk, "core.contact.create", { partyId, name: "Luis" }))).toMatchObject(forbidden);
    expect(await refusal(runProcess(h.deps, clerk, "core.contact.update", { id: contactId, name: "Ana María" }))).toMatchObject(forbidden);
    expect(await refusal(runProcess(h.deps, clerk, "core.contact.delete", { id: contactId }))).toMatchObject(forbidden);
    await narrow("core.party", partyId, { modify: true });
    await expect(runProcess(h.deps, clerk, "core.contact.update", { id: contactId, name: "Ana María" })).resolves.toBeTruthy();
  });

  it("deactivating a party is a state change (as every deactivate of a maestro): it needs the modify right, not delete", async () => {
    const partyId = (await runProcess(h.deps, h.admin, "core.party.create", { ...exito, documentNumber: "890900609" })).id as string;
    await runProcess(h.deps, h.admin, "core.party.save", { id: partyId });
    await narrow("core.party", partyId, { delete: true });
    expect(await refusal(runProcess(h.deps, clerk, "core.party.deactivate", { id: partyId }))).toMatchObject({ code: "record_forbidden", details: { right: "modify" } });
    await narrow("core.party", partyId, { modify: true });
    await expect(runProcess(h.deps, clerk, "core.party.deactivate", { id: partyId })).resolves.toBeTruthy();
  });

  it("core.category.update needs the modify right on the category (core.product_category)", async () => {
    const { id } = (await runProcess(h.deps, h.admin, "core.category.create", { name: "Café reservado", ivaRate: "5", otherTaxes: [] })) as { id: string };
    await narrow("core.product_category", id);
    expect(await refusal(runProcess(h.deps, clerk, "core.category.update", { id, name: "Café especial" }))).toMatchObject({
      code: "record_forbidden", details: { entity: "core.product_category", recordId: id, right: "modify" },
    });
  });
});
