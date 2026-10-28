import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runProcess, type Caller } from "@erp/kernel";
import { coreHarness, type CoreHarness } from "./helpers";

describe("core document sequences", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let deps: CoreHarness["deps"];
  let admin: Caller;
  let companyId: string;

  beforeAll(async () => {
    h = await coreHarness({ companies: 2 });
    ({ sql, deps, admin, companyId } = h);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("next_sequence is gap-free under 20 concurrent calls", async () => {
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, padding) values (${companyId}, 'FE', 'FE-', 1, 5)`;
    const numbers = await Promise.all(Array.from({ length: 20 }, () => runProcess(deps, admin, "core.sequence.next", { documentType: "FE", prefix: "FE-" })));
    expect(new Set(numbers.map((n) => n.number)).size).toBe(20);
    expect(numbers.map((n) => n.number)).toContain("FE-00001");
    expect(numbers.map((n) => n.number).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `FE-${String(i + 1).padStart(5, "0")}`));
    const [row] = await sql`select next_number from core.document_sequences where company_id = ${companyId} and document_type = 'FE'`;
    expect(Number(row!.next_number)).toBe(21);
  });

  it("numbers longer than the padding are never truncated", async () => {
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, padding) values (${companyId}, 'NC', '', 123456, 3)`;
    await expect(runProcess(deps, admin, "core.sequence.next", { documentType: "NC", prefix: "" })).resolves.toEqual({ number: "123456" });
  });

  it("an unknown sequence is not_found and another company's sequence is invisible", async () => {
    await expect(runProcess(deps, admin, "core.sequence.next", { documentType: "XX", prefix: "X-" })).rejects.toMatchObject({ code: "not_found" });
    const otherCompany = h.seed.companies[1]!.id;
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, padding) values (${otherCompany}, 'POS', 'P', 1, 4)`;
    await expect(runProcess(deps, admin, "core.sequence.next", { documentType: "POS", prefix: "P" })).rejects.toMatchObject({ code: "not_found" });
    const [row] = await sql`select next_number from core.document_sequences where company_id = ${otherCompany}`;
    expect(Number(row!.next_number)).toBe(1);
  });
});
