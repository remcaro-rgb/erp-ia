import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ResolutionError, nextInvoiceNumber, type NumberingTx, type Resolution } from "@erp/loc-co";
import { coreHarness, type CoreHarness } from "./helpers";

const base: Resolution = {
  number: "18760000001", prefix: "SETP", from: 990000000, to: 990000004,
  validFrom: "2026-01-01", validTo: "2026-12-31", technicalKey: "fc8eac422eba16e22ffd8c6f94b3f40a6e38162c",
};
/** What a refusal answers of the resolution (migration 0104): its data and the key's last characters, never the key. */
const refused: Record<string, unknown> = { ...base, technicalKeyEnding: base.technicalKey.slice(-4) };
delete refused.technicalKey;

describe("DIAN document numbering (core.next_document_number)", () => {
  let h: CoreHarness;
  let sql: CoreHarness["sql"];
  let companyId: string;

  const seed = async (type: string, resolution: Resolution, nextNumber = resolution.from) => {
    await sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
              values (${companyId}, ${type}, ${resolution.prefix}, ${nextNumber}, ${sql.json(resolution as never)})`;
  };
  const draw = (type: "invoice" | "credit_note" | "debit_note", date = "2026-06-01") =>
    sql.begin((tx) => nextInvoiceNumber(tx as unknown as NumberingTx, companyId, type, date));

  beforeAll(async () => {
    h = await coreHarness({ companies: 2 });
    ({ sql, companyId } = h);
  });
  afterAll(async () => {
    await h.cleanup();
  });

  it("rejects impossible dates and unbounded digit strings", async () => {
    const insert = (r: object) => sql`insert into core.document_sequences(company_id, document_type, prefix, resolution)
                                      values (${companyId}, 'invoice', 'BAD', ${sql.json(r as never)})`;
    await expect(insert({ ...base, validFrom: "2026-02-30" })).rejects.toThrow(/resolution_valid/);
    await expect(insert({ ...base, validTo: "2026-13-01" })).rejects.toThrow(/resolution_valid/);
    await expect(insert({ ...base, to: 1e19 })).rejects.toThrow(/resolution_valid/);
    await expect(insert({ ...base, from: 1.5 })).rejects.toThrow(/resolution_valid/);
  });

  it("rollover: two concurrent callers with row 1 on its last number get its last and row 2's first, no false refusal", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", { ...base, prefix: "OLD", from: 1, to: 5 }, 5);
    await seed("invoice", { ...base, prefix: "NEW", number: "18760000009", from: 100, to: 200 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstHas!: () => void;
    const first = new Promise<void>((r) => (firstHas = r));
    const t1 = sql.begin(async (tx) => {
      const n = await nextInvoiceNumber(tx as unknown as NumberingTx, companyId, "invoice", "2026-06-01");
      firstHas();
      await gate;
      return n;
    });
    await first;
    const t2 = sql.begin((tx) => nextInvoiceNumber(tx as unknown as NumberingTx, companyId, "invoice", "2026-06-01"));
    await new Promise((r) => setTimeout(r, 300));
    release();
    const [a, b] = await Promise.all([t1, t2]);
    expect([a.full, b.full]).toEqual(["OLD5", "NEW100"]);
  });

  it("a caller whose active company is B cannot draw from company A", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", base);
    const claims = h.seed.claimsFor(h.seed.users.both, h.seed.companies[1]!.id);
    await expect(
      sql.begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        return tx`select core.next_document_number(${companyId}::uuid, 'invoice', '2026-06-01'::date)`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects a malformed resolution", async () => {
    await expect(sql`insert into core.document_sequences(company_id, document_type, prefix, resolution)
                     values (${companyId}, 'invoice', 'BAD', ${sql.json({ number: "1" } as never)})`).rejects.toThrow(/resolution_valid/);
    await expect(sql`insert into core.document_sequences(company_id, document_type, prefix, resolution)
                     values (${companyId}, 'invoice', 'BAD', ${sql.json({ ...base, to: 5 } as never)})`).rejects.toThrow(/resolution_valid/);
  });

  it("draws consecutive numbers, refuses past the range end and leaves the counter alone", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", base);
    const got = [];
    for (let i = 0; i < 5; i++) got.push((await draw("invoice")).full);
    expect(got).toEqual(["SETP990000000", "SETP990000001", "SETP990000002", "SETP990000003", "SETP990000004"]);
    const err = await draw("invoice").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResolutionError);
    expect(err).toMatchObject({ code: "out_of_range", resolution: refused });
    const [row] = await sql`select next_number from core.document_sequences where company_id = ${companyId} and document_type = 'invoice'`;
    expect(Number(row!.next_number)).toBe(990000005);
  });

  it("refuses after the validity end and before its start, with the resolution data", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", base);
    await expect(draw("invoice", "2027-01-01")).rejects.toMatchObject({ code: "expired", resolution: refused });
    await expect(draw("invoice", "2025-12-31")).rejects.toMatchObject({ code: "not_yet_valid" });
    await expect(draw("invoice", "2026-12-31")).resolves.toMatchObject({ number: 990000000 });
  });

  it("two real transactions draw distinct consecutive numbers (the second waits for the first)", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", { ...base, to: 990000100 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstHasNumber!: () => void;
    const first = new Promise<void>((r) => (firstHasNumber = r));
    const t1 = sql.begin(async (tx) => {
      const n = await nextInvoiceNumber(tx as unknown as NumberingTx, companyId, "invoice", "2026-06-01");
      firstHasNumber();
      await gate; // holds the row lock until released
      return n;
    });
    await first;
    const t2 = sql.begin((tx) => nextInvoiceNumber(tx as unknown as NumberingTx, companyId, "invoice", "2026-06-01"));
    let t2Done = false;
    void t2.then(() => (t2Done = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(t2Done).toBe(false);
    release();
    const [a, b] = await Promise.all([t1, t2]);
    expect([a.number, b.number]).toEqual([990000000, 990000001]);
  });

  it("20 concurrent callers get 20 distinct consecutive numbers", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", { ...base, to: 990000100 });
    const all = await Promise.all(Array.from({ length: 20 }, () => draw("invoice")));
    expect(all.map((n) => n.number).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => 990000000 + i));
  });

  it("a rolled-back transaction leaves no gap", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", base);
    await sql.begin(async (tx) => {
      await nextInvoiceNumber(tx as unknown as NumberingTx, companyId, "invoice", "2026-06-01");
      throw new Error("issuing failed");
    }).catch(() => undefined);
    await expect(draw("invoice")).resolves.toMatchObject({ number: 990000000 });
  });

  it("credit notes draw from their own sequence", async () => {
    await sql`delete from core.document_sequences where company_id = ${companyId}`;
    await seed("invoice", base);
    await seed("credit_note", { ...base, prefix: "NC", number: "18760000002", from: 1, to: 50 });
    expect((await draw("invoice")).full).toBe("SETP990000000");
    expect((await draw("credit_note")).full).toBe("NC1");
    expect((await draw("credit_note")).full).toBe("NC2");
    expect((await draw("invoice")).full).toBe("SETP990000001");
    // A note type with no numbering row of its own (Task 18, 0097): no_sequence.
    await expect(draw("debit_note")).rejects.toMatchObject({ code: "no_sequence" });
  });
});

describe("the technical key is stored apart (migration 0104)", () => {
  it("is not in the resolution kept on the sequence row; a draw by the server answers it with the number, a refusal never", async () => {
    const h = await coreHarness();
    try {
      await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number, resolution)
                  values (${h.companyId}, 'invoice', ${base.prefix}, ${base.from}, ${h.sql.json(base as never)})`;
      const [row] = await h.sql<{ resolution: Record<string, unknown> }[]>`select resolution from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice'`;
      expect(row!.resolution).not.toHaveProperty("technicalKey");
      expect(row!.resolution.technicalKeyEnding).toBe(base.technicalKey.slice(-4));
      const [key] = await h.sql<{ technical_key: string }[]>`select technical_key from core.document_resolution_keys where company_id = ${h.companyId} and resolution_number = ${base.number}`;
      expect(key!.technical_key).toBe(base.technicalKey);
      const drawn = await nextInvoiceNumber(h.sql as unknown as NumberingTx, h.companyId, "invoice", "2026-06-01");
      expect(drawn.resolution?.technicalKey).toBe(base.technicalKey);
    } finally {
      await h.cleanup();
    }
  });
});
