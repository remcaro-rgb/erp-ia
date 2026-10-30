import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { co } from "../index";

const acc = co.accounting;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/exogena/${name}`, import.meta.url), "utf8");

describe("exogena catalogue and XML", () => {
  it("lists the seven formats of 2026 with their side, threshold and the 222222222 NIT", () => {
    const formats = acc.exogenaFormats(2026);
    expect(formats.map((f) => f.format)).toEqual(["1001", "1003", "1005", "1006", "1007", "1008", "1009"]);
    expect(Object.fromEntries(formats.map((f) => [f.format, f.side]))).toEqual({ 1001: "debit", 1003: "debit", 1005: "debit", 1006: "credit", 1007: "credit", 1008: "balance", 1009: "balance" });
    for (const f of formats) {
      expect(f).toMatchObject({ year: 2026, cuantiasMenoresNit: "222222222" });
      expect(f.threshold).toBeGreaterThanOrEqual(0);
      expect(f.concepts.length).toBeGreaterThan(0);
      expect(f.columns.length).toBeGreaterThan(0);
    }
    expect(formats.find((f) => f.format === "1001")?.concepts.map((c) => c.code)).toEqual(expect.arrayContaining(["5001", "5002", "5004", "5005", "5007"]));
    expect(() => acc.exogenaFormats(2020)).toThrow();
  });

  it("writes the 1001 XML the prevalidador accepts for two rows (fixture byte-equal) and counts CantReg and ValorTotal", () => {
    const format = acc.exogenaFormats(2026).find((f) => f.format === "1001")!;
    const xml = acc.exogenaXml(
      format,
      [
        { concept: "5001", partyDocumentType: "13", partyDocument: "1020304050", partyName: "Ana Pérez", departmentCode: "05", municipalityCode: "001", countryCode: "169", values: { pagoded: 3000000, retefuente: 150000, reteivacom: 0 } },
        { concept: "5002", partyDocumentType: "31", partyDocument: "900373115", partyDv: "3", partyName: 'Éxito & Cía "S.A.S."', departmentCode: "11", municipalityCode: "001", countryCode: "169", values: { pagoded: 1500000.4, retefuente: 165000 } },
      ],
      { nit: "900373115", dv: "3", name: "Café del Norte S.A.S.", year: 2026 },
    );
    expect(xml).toBe(fixture("1001-two-rows.xml"));
  });

  it("refuses a row whose concept or value column is not in the format", () => {
    const format = acc.exogenaFormats(2026).find((f) => f.format === "1001")!;
    const company = { nit: "900373115", dv: "3", name: "x", year: 2026 };
    const row = { concept: "9999", partyDocumentType: "13", partyDocument: "1", partyName: "x", countryCode: "169", values: { pagoded: 1 } };
    expect(() => acc.exogenaXml(format, [row], company)).toThrow(/9999/);
    expect(() => acc.exogenaXml(format, [{ ...row, concept: "5001", values: { nope: 1 } }], company)).toThrow(/nope/);
  });

  it("every default concept mapping names a format and concept of the catalogue and a code of the chart", () => {
    const formats = acc.exogenaFormats(2026);
    const chart = new Set(acc.chartOfAccounts().map((a) => a.code));
    const mappings = acc.defaultConceptMappings();
    expect(mappings.length).toBeGreaterThanOrEqual(8);
    for (const m of mappings) {
      const format = formats.find((f) => f.format === m.format);
      expect(format, m.format).toBeDefined();
      expect(format!.concepts.some((c) => c.code === m.concept), `${m.format}/${m.concept}`).toBe(true);
      expect(chart.has(m.code), `${m.format}/${m.concept} → ${m.code}`).toBe(true);
    }
    for (const expected of [["1001", "5001", "5105"], ["1001", "5002", "5110"], ["1001", "5004", "5135"], ["1001", "5005", "5120"], ["1001", "5007", "1435"], ["1006", "4001", "41"], ["1008", "1315", "1305"], ["1009", "2201", "2205"]]) {
      expect(mappings).toContainEqual({ format: expected[0], concept: expected[1], code: expected[2] });
    }
    const seen = new Set(mappings.map((m) => `${m.format}/${m.code}`));
    expect(seen.size).toBe(mappings.length);
  });
});
