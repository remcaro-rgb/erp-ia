import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ensureRoleProbe, ROLE_PROBE, seedTenant, testDb } from "../db/test-db";
import { withClaims } from "../db/client";
import { Registry } from "../registry";
import { loadModules } from "../module/loader";
import { kernelModule } from "../module/kernel-module";
import { runProcess } from "../process/run";
import { MemoryFileStore, setFileStore } from "../files/store";
import type { Caller } from "../process/context";

// Photo order, the suggested-photo flag and the AI photo placeholder (design §5.18; Task 12b). The tests use the
// kernel's own probe table as the owning entity: attaching to it needs `kernel.attachment.add`, as it declares.
// The kernel's own `attachments_changed` readiness hook (migration 0014) is a no-op, so the probe needs nothing more.

describe("attachment order, suggested photos and the required-file view", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let admin: Caller;
  let cashier: Caller;
  let otherCompanyAdmin: Caller;
  let recordId: string;
  let otherRecordId: string;
  const store = new MemoryFileStore();
  const companyIds = () => seed.companies.map((c) => c.id);
  const run = (caller: Caller, id: string, input: unknown) => runProcess({ sql, registry }, caller, id, input);
  const PROBE = "kernel.role_probe";

  const file = (name: string, tag = "Foto", over: Record<string, unknown> = {}) => ({
    entity: PROBE,
    recordId,
    tag,
    fileName: name,
    mimeType: "image/png",
    sizeBytes: 100,
    storagePath: `${seed.tenantId}/${seed.companies[0]!.id}/${PROBE}/${recordId}/0192-${name}`,
    ...over,
  });
  const add = (name: string, tag = "Foto") => run(admin, "kernel.attachment.add", file(name, tag));
  const names = async (caller: Caller = admin, record = recordId) =>
    (await run(caller, "kernel.attachment.list", { entity: PROBE, recordId: record })).map((a: { fileName: string }) => a.fileName);
  const idsOf = async () => (await run(admin, "kernel.attachment.list", { entity: PROBE, recordId })).map((a: { id: string }) => a.id);

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    seed = await seedTenant(sql, { companies: 2, users: [{ name: "cashier", companies: [0], role: "member" }] });
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    registry.registerEntity({ ...ROLE_PROBE, processIds: { attach: "kernel.attachment.add" } });
    setFileStore(store);
    admin = { claims: seed.claimsFor(seed.users.both, seed.companies[0]!.id), origin: "ui" };
    cashier = { claims: seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id), origin: "ui" };
    otherCompanyAdmin = { claims: seed.claimsFor(seed.users.both, seed.companies[1]!.id), origin: "ui" };
    const processes = ["kernel.attachment.add", "kernel.attachment.list", "kernel.attachment.remove", "kernel.attachment.reorder", "kernel.ai.image_suggest"];
    for (const company of seed.companies) {
      for (const process of processes) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${process})`;
      }
    }
    recordId = (await sql`insert into kernel.role_probe(company_id, secret) values (${seed.companies[0]!.id}, 's') returning id`)[0]!.id;
    otherRecordId = (await sql`insert into kernel.role_probe(company_id, secret) values (${seed.companies[1]!.id}, 's') returning id`)[0]!.id;
  });
  afterAll(async () => {
    setFileStore(undefined);
    await sql`delete from kernel.role_probe where company_id = any(${companyIds()}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds()}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("lists in upload order until reordered; a new file goes last, also after a reorder", async () => {
    const a = await add("a.png");
    const b = await add("b.png");
    const c = await add("c.png");
    expect(await names()).toEqual(["a.png", "b.png", "c.png"]);
    expect([a, b, c].map((x) => x.position)).toEqual([0, 1, 2]);

    await run(admin, "kernel.attachment.reorder", { entity: PROBE, recordId, orderedIds: [c.id, a.id, b.id] });
    expect(await names()).toEqual(["c.png", "a.png", "b.png"]);
    expect((await run(admin, "kernel.attachment.list", { entity: PROBE, recordId })).map((x: { position: number }) => x.position)).toEqual([0, 1, 2]);

    await add("d.png");
    expect(await names()).toEqual(["c.png", "a.png", "b.png", "d.png"]);
  });

  it("reorder refuses ids of another record, a repeated id, a removed file and an empty list; nothing changes", async () => {
    const before = await idsOf();
    const foreign = (await sql`insert into kernel.attachments(company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
      values (${seed.companies[1]!.id}, ${PROBE}, ${otherRecordId}, 'Foto', 'x.png', 'image/png', 1, ${`${seed.tenantId}/${seed.companies[1]!.id}/${PROBE}/${otherRecordId}/0192-x.png`}) returning id`)[0]!.id as string;
    const reorder = (orderedIds: string[]) => run(admin, "kernel.attachment.reorder", { entity: PROBE, recordId, orderedIds });
    await expect(reorder([...before, foreign])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reorder([before[0]!, before[0]!])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(reorder([])).rejects.toMatchObject({ code: "invalid_input" });
    const gone = await add("gone.png");
    await run(admin, "kernel.attachment.remove", { id: gone.id });
    await expect(reorder([gone.id, ...before])).rejects.toMatchObject({ code: "invalid_input" });
    expect(await idsOf()).toEqual(before);
    // The other company's admin cannot reorder this record's files at all.
    await expect(run(otherCompanyAdmin, "kernel.attachment.reorder", { entity: PROBE, recordId, orderedIds: before })).rejects.toMatchObject({ code: "not_found" });
  });

  it("needs the reorder permission", async () => {
    const ids = await idsOf();
    await expect(run(cashier, "kernel.attachment.reorder", { entity: PROBE, recordId, orderedIds: ids })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("a user cannot write a position outside the process (company RLS and the GUC-gated update policy)", async () => {
    const [first] = await idsOf();
    // The restrictive policy hides the row from the update: nothing is written, no error either.
    const touched = await withClaims(sql, admin.claims, (tx) => tx`update kernel.attachments set position = 99 where id = ${first!} returning id`);
    expect(touched).toHaveLength(0);
    expect((await sql`select position from kernel.attachments where id = ${first!}`)[0]!.position).not.toBe(99);
    // The process may, and the file stays otherwise immutable.
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('erp.audit_process_id', 'kernel.attachment.reorder', true)`;
        await tx`update kernel.attachments set file_name = 'otro.png' where id = ${first!}`;
      }),
    ).rejects.toThrow(/can only be removed or reordered/);
  });

  it("making a suggested photo principal clears its suggested flag; an uploaded one stays as it is", async () => {
    const suggested = await run(admin, "kernel.ai.image_suggest", { entity: PROBE, recordId, description: "Café tostado molido 500 g", uom: "94", category: "Café" });
    expect(suggested).toMatchObject({ tag: "Foto · IA", mimeType: "image/svg+xml", suggested: true, recordId });
    const listed = await run(admin, "kernel.attachment.list", { entity: PROBE, recordId });
    expect(listed.find((x: { id: string }) => x.id === suggested.id)).toMatchObject({ suggested: true });
    expect(listed.filter((x: { suggested: boolean }) => x.suggested)).toHaveLength(1);

    const order = (await idsOf()).filter((id: string) => id !== suggested.id);
    await run(admin, "kernel.attachment.reorder", { entity: PROBE, recordId, orderedIds: [order[0]!, suggested.id, ...order.slice(1)] });
    // Not first: still a suggestion.
    expect((await run(admin, "kernel.attachment.list", { entity: PROBE, recordId })).find((x: { id: string }) => x.id === suggested.id)).toMatchObject({ suggested: true });
    await run(admin, "kernel.attachment.reorder", { entity: PROBE, recordId, orderedIds: [suggested.id, ...order] });
    const after = await run(admin, "kernel.attachment.list", { entity: PROBE, recordId });
    expect(after[0]).toMatchObject({ id: suggested.id, suggested: false, tag: "Foto · IA" });
  });

  describe("kernel.ai.image_suggest", () => {
    it("stores a deterministic svg placeholder through the file store as the attachment's file", async () => {
      const out = await run(admin, "kernel.ai.image_suggest", { entity: PROBE, recordId, description: "Prensa francesa 600 ml" });
      expect(out).toMatchObject({ tag: "Foto · IA", mimeType: "image/svg+xml", suggested: true, uploadedBy: seed.users.both });
      expect(out.fileName).toMatch(/\.svg$/);
      const [row] = await sql`select storage_path, size_bytes, suggested from kernel.attachments where id = ${out.id}`;
      expect(row!.suggested).toBe(true);
      expect(row!.storage_path).toMatch(new RegExp(`^${seed.tenantId}/${seed.companies[0]!.id}/${PROBE}/${recordId}/`));
      const bytes = Buffer.from(await store.get(row!.storage_path as string));
      expect(bytes.byteLength).toBe(Number(row!.size_bytes));
      expect(bytes.toString("utf8")).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(bytes.toString("utf8")).toContain("PF");
      // The same description makes the same picture; asking twice adds a second file with its own name.
      const again = await run(admin, "kernel.ai.image_suggest", { entity: PROBE, recordId, description: "Prensa francesa 600 ml" });
      expect(again.id).not.toBe(out.id);
      expect(again.fileName).not.toBe(out.fileName);
      const [second] = await sql`select storage_path from kernel.attachments where id = ${again.id}`;
      expect(Buffer.from(await store.get(second!.storage_path as string)).equals(bytes)).toBe(true);
    });

    it("is audited as its own process and refused without permission or for a record the caller cannot see", async () => {
      const [entry] = await sql`select origin, process_id from kernel.audit_log where process_id = 'kernel.ai.image_suggest' order by occurred_at desc limit 1`;
      expect(entry).toMatchObject({ process_id: "kernel.ai.image_suggest", origin: "ui" });
      await expect(run(cashier, "kernel.ai.image_suggest", { entity: PROBE, recordId, description: "Algo" })).rejects.toMatchObject({ code: "forbidden" });
      await expect(run(otherCompanyAdmin, "kernel.ai.image_suggest", { entity: PROBE, recordId, description: "Algo" })).rejects.toMatchObject({ code: "not_found" });
      await expect(run(admin, "kernel.ai.image_suggest", { entity: PROBE, recordId, description: "   " })).rejects.toMatchObject({ code: "invalid_input" });
    });

    it("leaves no bytes behind when the record refuses the file", async () => {
      const before = store.files.size;
      await expect(run(admin, "kernel.ai.image_suggest", { entity: PROBE, recordId: "00000000-0000-4000-8000-000000000000", description: "Algo" })).rejects.toMatchObject({ code: "not_found" });
      expect(store.files.size).toBe(before);
    });
  });

  describe("kernel.v_required_attachments", () => {
    it("shows the caller's company definitions only", async () => {
      const [mine, theirs] = seed.companies;
      await sql`insert into kernel.required_attachments(company_id, entity, tag, kind, required, condition)
        values (${mine!.id}, 'core.party', 'Contrato', 'pdf', true, 'co'), (${theirs!.id}, 'core.party', 'Solo de la otra empresa', 'pdf', true, null)`;
      const seen = await withClaims(sql, admin.claims, (tx) => tx`select company_id, tag, kind, required, condition from kernel.v_required_attachments where entity = 'core.party'`);
      expect(seen.every((r) => r.company_id === mine!.id)).toBe(true);
      expect(seen.find((r) => r.tag === "Contrato")).toMatchObject({ kind: "pdf", required: true, condition: "co" });
      expect(seen.map((r) => r.tag)).not.toContain("Solo de la otra empresa");
      const cashierSees = await withClaims(sql, cashier.claims, (tx) => tx`select tag from kernel.v_required_attachments where tag in ('Contrato', 'Solo de la otra empresa')`);
      expect(cashierSees.map((r) => r.tag)).toEqual(["Contrato"]);
    });
  });
});
