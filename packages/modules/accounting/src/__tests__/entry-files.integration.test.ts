import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "./helpers";

// A comprobante takes files (the support of the entry, accounting design §8, rule 22): the kernel's attachments trigger needs the
// owning module's `attachments_changed` hook (migration 0035), which the accounting schema has to define.

let h: AccountingHarness;
let entryId: string;
beforeAll(async () => {
  h = await accountingHarness();
  const [journal] = await h.sql<{ id: string }[]>`insert into accounting.journals (company_id, code, name, kind) values (${h.companyId}, 'NC', 'Notas de contabilidad', 'general') returning id`;
  const [entry] = await h.sql<{ id: string }[]>`
    insert into accounting.entries (company_id, journal_id, date, description) values (${h.companyId}, ${journal!.id}, '2026-10-15', 'Con soporte') returning id`;
  entryId = entry!.id;
});
afterAll(async () => {
  await h.cleanup();
});

describe("entry files", () => {
  it("accounting defines the attachments hook and a file can be added to and removed from a comprobante", async () => {
    const [hook] = await h.sql<{ defined: boolean }[]>`select to_regprocedure('accounting.attachments_changed(text,uuid,uuid)') is not null as defined`;
    expect(hook!.defined).toBe(true);

    const added = await h.run<{ id: string; fileName: string }>(h.admin, "kernel.attachment.add", {
      entity: "accounting.entry", recordId: entryId, tag: "Soporte", fileName: "soporte.pdf", mimeType: "application/pdf", sizeBytes: 1200,
      storagePath: `${h.seed.tenantId}/${h.companyId}/accounting.entry/${entryId}/${crypto.randomUUID()}-soporte.pdf`,
    });
    expect(added.fileName).toBe("soporte.pdf");
    const listed = await h.run<{ fileName: string }[]>(h.admin, "kernel.attachment.list", { entity: "accounting.entry", recordId: entryId });
    expect(listed.map((f) => f.fileName)).toEqual(["soporte.pdf"]);

    await h.run(h.admin, "kernel.attachment.remove", { id: added.id });
    expect(await h.run<unknown[]>(h.admin, "kernel.attachment.list", { entity: "accounting.entry", recordId: entryId })).toEqual([]);
  });
});
