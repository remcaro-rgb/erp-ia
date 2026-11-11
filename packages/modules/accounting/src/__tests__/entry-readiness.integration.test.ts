import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "./helpers";

// Rule 10 and design §5.17 on the accounting side, gated per account: an account flagged `requires_invoice_ready` (the
// receivable and payable accounts of the pack) takes only a party that is invoice-ready, draft or post. Other accounts
// take any visible party, as before.

let h: AccountingHarness;
let year: number;
let cc: string;
let notReady: string;
let ready: string;

const party = async (documentNumber: string, checkDigit: string, legalName: string) => {
  const [row] = await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, check_digit, legal_name,
      tax_responsibilities, tax_scheme, country_code, department_code, municipality_code, address_line, invoice_email, dian_status)
    values (${h.companyId}, '{customer}', '1', '31', ${documentNumber}, ${checkDigit}, ${legalName}, '{O-13}', '01', 'CO', '11', '11001',
      'Cra 1 # 2-3', 'fe@cliente.co', 'complete') returning id`;
  return row!.id;
};

beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  cc = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;

  // DIAN data complete everywhere; only the required files differ.
  notReady = await party("900373115", "3", "Supermercados Éxito");
  ready = await party("900111222", "7", "Tiendas D1 S.A.S.");
  for (const tag of ["RUT", "Cámara de Comercio"]) {
    await h.sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
      values (${h.companyId}, 'core.party', ${ready}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024,
        ${`${h.seed.tenantId}/${h.companyId}/core.party/${ready}/${tag}.pdf`})`;
  }
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const receivable = (partyId: string) => [
  { accountCode: "130505", debit: 100, credit: 0, partyId },
  { accountCode: "111005", debit: 0, credit: 100 },
];
const draft = (lines: object[]) => ({ date: `${year}-10-15`, description: "Prueba de tercero", lines });

describe("invoice readiness per account (rule 10)", () => {
  it("the pack flags the receivable and payable accounts only", async () => {
    const rows = await h.sql<{ code: string; requires_invoice_ready: boolean }[]>`
      select code, requires_invoice_ready from accounting.accounts
      where company_id = ${h.companyId} and code in ('130505', '220505', '510506') order by code`;
    expect(rows).toEqual([
      { code: "130505", requires_invoice_ready: true },
      { code: "220505", requires_invoice_ready: true },
      { code: "510506", requires_invoice_ready: false },
    ]);
  });

  it("a draft on a flagged account with a party that is not invoice-ready is refused as missing_party, naming the party", async () => {
    await expect(h.run(h.contador, "accounting.entry.create", draft(receivable(notReady)))).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("missing_party"),
      details: [expect.stringContaining("no está listo para facturar")],
    });
  });

  it("the same party on an account that is not flagged drafts and posts", async () => {
    const lines = [
      { accountCode: "510506", debit: 100, credit: 0, partyId: notReady, costCenterId: cc },
      { accountCode: "111005", debit: 0, credit: 100 },
    ];
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft(lines));
    await h.run(h.contador, "accounting.entry.save", { id });
    const [row] = await h.sql<{ status: string }[]>`select status from accounting.entries where id = ${id}`;
    expect(row!.status).toBe("posted");
  });

  it("a party that is invoice-ready drafts and posts on a flagged account", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", draft(receivable(ready)));
    await h.run(h.contador, "accounting.entry.save", { id });
    const [row] = await h.sql<{ status: string }[]>`select status from accounting.entries where id = ${id}`;
    expect(row!.status).toBe("posted");
  });
});
