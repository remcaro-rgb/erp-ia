import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPORT_PROCESSES, kernelModule, loadModules, registry, setFileStore, type Caller } from "@erp/kernel";
import { runImport, submitImport } from "@erp/kernel/import";
import { MemoryFileStore, xlsxBook } from "@erp/kernel/testing";
import { core } from "@erp/module-core";
import { accounting } from "../index";
import { accountingHarness, type AccountingHarness } from "./helpers";

// Importing comprobantes (entity types spec §2.5, D14, §10.2; Task 13 fix round 1, C1): an Excel file with the Datos sheet (one row per
// comprobante) and the Líneas sheet (one row per line), joined by `ref`. Each comprobante is created with its lines through
// accounting.entry.create as the importer and stays Borrador: an import never grabs, approves or posts. A bad line refuses only its
// comprobante, header and lines.

let h: AccountingHarness;
let year: number;
const store = new MemoryFileStore();

beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ["kernel.attachment.add", ...IMPORT_PROCESSES.map((p) => p.id)]);
  // The workflow resolves entities and processes from the process-wide registry, as the app's workers do.
  if (!registry.hasModule(kernelModule.id)) loadModules(registry, [kernelModule, core, accounting]);
  setFileStore(store);
}, 180_000);
afterAll(async () => {
  setFileStore(undefined);
  await h.sql`delete from kernel.step_up_verifications where company_id = ${h.companyId}`;
  await h.cleanup();
});

describe("comprobante import (C1)", () => {
  it("two comprobantes land Borrador with their lines, never posted; a bad line refuses only its comprobante", async () => {
    const day = `${year}-03-15`;
    const bytes = await xlsxBook([
      { name: "Datos", rows: [["ref", "date", "description"], ["1", day, "Aporte importado"], ["2", day, "Venta importada"], ["3", day, "Con línea mala"]] },
      {
        name: "Líneas",
        rows: [
          ["ref", "accountCode", "debit", "credit"],
          ["1", "111005", 10_000, 0],
          ["1", "310505", 0, 10_000],
          ["2", "111005", 3_000, 0],
          ["2", "413595", 0, 3_000],
          ["3", "111005", 500, 0],
          ["3", "310505", 0, 0],
        ],
      },
    ]);
    const stepUpToken = randomUUID();
    await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${h.seed.users.both}, ${h.companyId}, ${stepUpToken})`;
    const caller: Caller = { ...h.admin, stepUpToken };
    const ids = await submitImport({ sql: h.sql, registry }, caller, { entity: "accounting.entry", fileName: "comprobantes.xlsx", bytes });
    const summary = await runImport({ ...ids, claims: h.admin.claims });
    expect(summary).toMatchObject({ status: "done", total: 3, created: 2, rejected: 1 });

    const entries = await h.sql<{ description: string; status: string; number: string | null; posted_at: Date | null; lines: string[] }[]>`
      select e.description, e.status, e.number, e.posted_at,
             array(select a.code || ':' || l.debit::int || ':' || l.credit::int from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id
                   where l.entry_id = e.id order by l.line_no) as lines
      from accounting.entries e where e.company_id = ${h.companyId} and (e.description like '%importad%' or e.description = 'Con línea mala')
      order by e.description`;
    expect(entries).toEqual([
      { description: "Aporte importado", status: "draft", number: null, posted_at: null, lines: ["111005:10000:0", "310505:0:10000"] },
      { description: "Venta importada", status: "draft", number: null, posted_at: null, lines: ["111005:3000:0", "413595:0:3000"] },
    ]);
    const [row] = await h.sql<{ errors_attachment_id: string }[]>`select errors_attachment_id from kernel.imports where id = ${ids.importId}`;
    const [file] = await h.sql<{ storage_path: string }[]>`select storage_path from kernel.attachments where id = ${row!.errors_attachment_id}`;
    const errors = new TextDecoder().decode(await store.get(file!.storage_path)).trimEnd().split("\r\n");
    expect(errors[1]).toMatch(/^Datos 4;Líneas, fila 7: /);
    expect(errors.slice(2)).toEqual(["Líneas 6;;;;;3;111005;500;0", "Líneas 7;;;;;3;310505;0;0"]);
  });
});
