import { describe, expect, it } from "vitest";
import { hasRestrictedLines, returnToDraftInput } from "./entry-return";

const entry = {
  id: "e1", journal_id: "j1", date: new Date("2026-10-30T00:00:00Z"), description: "Nota", currency: "COP", exchange_rate: "1.000000", business_unit_id: null, reverse_on: null,
  lines: [
    { account_id: "a1", party_id: null, debit: "1000.0000", credit: "0.0000", description: "", tax_rate: null, due_date: null, is_restricted: false },
    { account_id: "a2", party_id: "p1", debit: "0.0000", credit: "1000.0000", description: "Pago", tax_rate: "19.0000", tax_base: "1000.0000", due_date: new Date("2026-11-15T00:00:00Z"), is_restricted: false },
  ],
};

describe("returnToDraftInput", () => {
  it("keeps the header and every line as the update process takes them", () => {
    const input = returnToDraftInput(entry);
    expect(input).toMatchObject({ id: "e1", journalId: "j1", date: "2026-10-30", description: "Nota", exchangeRate: 1, businessUnitId: null, reverseOn: null });
    const lines = input.lines as Record<string, unknown>[];
    expect(lines[0]).toMatchObject({ accountId: "a1", debit: 1000, credit: 0, description: null, partyId: null });
    expect(lines[1]).toMatchObject({ accountId: "a2", partyId: "p1", credit: 1000, description: "Pago", taxRate: 19, taxBase: 1000, dueDate: "2026-11-15" });
  });

  it("is refused for a comprobante with a restricted line", () => {
    expect(hasRestrictedLines(entry)).toBe(false);
    expect(hasRestrictedLines({ ...entry, lines: [...entry.lines, { is_restricted: true }] })).toBe(true);
  });
});
