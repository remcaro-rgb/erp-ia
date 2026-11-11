import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
// The payments harness (core, accounting on the demo chart, invoicing and payments): accounting cannot depend on payments or invoicing.
import { paymentsHarness, type Harness } from "../../../payments/src/__tests__/helpers";
import { DEMO_COMPANY_ID, DEMO_TENANT_ID } from "../../../../../scripts/demo/accounts";

// Open items in both currencies (plan 2B.2 Task 34.7; FX §7, §11 0153; review focus 1-3 of Task 34):
//   (1) regression: every row of accounting.open_items and open_items_allocated equals its 0138 value, on this harness's peso ledger and,
//       with DEMO_SEED=1, on the demo ledger of Café del Norte;
//   (2) a COP receipt settling two USD invoices at different rates splits its receivable line by amount_company (0138 split it by the
//       dollars, which leaves one invoice over and the other open): each invoice is open 0 in dollars and in pesos;
//   (3) open_doc = the invoice − its allocations − its notes, in dollars; amount_doc is the invoice entry's dollars.

const migration = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");

let h: Harness;
let usdMethod: string;
let export0: string;
let customers = 0;
const newCustomer = (name: string) => h.newCustomer(`9013400${String(++customers).padStart(2, "0")}`, name);

beforeAll(async () => {
  h = await paymentsHarness();
  usdMethod = (await h.run<{ id: string }>(h.admin, "payments.method.create", { code: "transfer_usd", name: "Transferencia USD", kind: "transfer", meansCode: "47", currency: "USD" })).id;
  export0 = (await h.run<{ id: string }>(h.admin, "core.product.create", {
    sku: "EXP-01", description: "Café verde de exportación", kind: "service", idScheme: "999", uomCode: "94", ivaRate: "0", otherTaxes: [], listPrice: 100000, isFreeSample: false, trackStock: false,
  })).id;
  await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${h.companyId}, 'credit_note', 'NC', 1), (${h.companyId}, 'debit_note', 'ND', 1)`;
}, 300_000);
afterAll(async () => {
  await h.sql`delete from core.exchange_rates where company_id = ${h.companyId}`;
  await h.cleanup();
});

type Item = { entry_id: string | null; kind: string; original: number; open: number; currency: string; amount_doc: number; open_doc: number };
/** accounting.open_items of a party as the admin, with the document-currency columns of 0153. */
const openItems = async (partyId: string, asOf = h.today): Promise<Item[]> =>
  (await withClaims(h.sql, h.admin.claims, (tx) => tx<{ entry_id: string | null; kind: string; original: string; open: string; currency: string; amount_doc: string; open_doc: string }[]>`
    select o.entry_id, o.kind, o.original::text, o.open::text, o.currency, o.amount_doc::text, o.open_doc::text
    from accounting.open_items(${h.companyId}, ${asOf}::date) o
    where o.party_id = ${partyId} order by o.kind, o.date, o.entry_id`))
    .map((r) => ({ ...r, original: Number(r.original), open: Number(r.open), amount_doc: Number(r.amount_doc), open_doc: Number(r.open_doc) }));
const invoiceEntry = async (invoiceId: string) => (await h.entriesOfSource(invoiceId))[0]!.id;
const itemOf = (items: Item[], entryId: string) => items.find((i) => i.kind === "document" && i.entry_id === entryId);

/** An issued export invoice (no IVA) of `qty` × `unitPrice` in `currency` at `rate` for `partyId`. */
const foreignInvoice = (partyId: string, qty: number, unitPrice: number, rate: number, currency = "USD") =>
  h.issuedInvoice(qty, { partyId, currency, exchangeRate: rate, productId: export0, unitPrice });

/**
 * The 0138 functions, created again under pg_temp in a transaction that rolls back: the reference the new versions are compared with. The
 * old open_items is FIFO for what the allocations do not answer, plus the old allocated items (its body, 0112).
 */
/** The claims of the demo company's admin (Laura), read from the seeded memberships. */
async function demoAdminClaims(): Promise<Record<string, unknown>> {
  const [m] = await h.sql<{ user_id: string; role_ids: string[] }[]>`
    select m.user_id, array_agg(mr.role_id) as role_ids
    from kernel.memberships m join kernel.membership_roles mr on mr.membership_id = m.id join kernel.roles r on r.id = mr.role_id
    where m.company_id = ${DEMO_COMPANY_ID} and r.is_system and r.name = 'admin' group by m.user_id order by m.user_id limit 1`;
  return { sub: m!.user_id, tenant_id: DEMO_TENANT_ID, company_ids: [DEMO_COMPANY_ID], active_company_id: DEMO_COMPANY_ID, role_ids: m!.role_ids, locale: "es-419" };
}

async function compareWith0138(companyId: string, asOf: string): Promise<{ before: unknown[]; after: unknown[]; beforeAll: unknown[]; afterAll: unknown[] }> {
  const ROLLBACK = new Error("rollback");
  const old = migration("0138_accounting_open_items_advance_applications.sql")
    .replaceAll("accounting.open_items_allocated(", "pg_temp.open_items_allocated_0138(")
    // 0150 widened payments.ledger_allocations; the old body reads only the three columns it knew.
    .replace(/^revoke .*$|^grant .*$|^comment on [\s\S]*?;$/gm, "");
  const seen = await h.sql.begin(async (tx) => {
    await tx.unsafe(old);
    const cols = "company_id, account_id, party_id, entry_id, line_no, date, due_date, original::numeric(18,2), open::numeric(18,2), kind";
    const order = "order by account_id, party_id, kind, date, entry_id, line_no, original";
    const run = (claimsTx: typeof tx) => Promise.all([
      claimsTx.unsafe(`select ${cols} from pg_temp.open_items_allocated_0138($1, $2::date) ${order}`, [companyId, asOf]),
      claimsTx.unsafe(`select ${cols} from accounting.open_items_allocated($1, $2::date) ${order}`, [companyId, asOf]),
      claimsTx.unsafe(`
        select ${cols} from (
          select f.company_id, f.account_id, f.party_id, f.entry_id, f.line_no, f.date, f.due_date, f.original, f.open, 'document'::text as kind
          from accounting.open_items_fifo($1, $2::date, accounting.open_items_follow_allocations($1)) f
          union all
          select a.company_id, a.account_id, a.party_id, a.entry_id, a.line_no, a.date, a.due_date, a.original, a.open, a.kind
          from pg_temp.open_items_allocated_0138($1, $2::date) a where accounting.open_items_follow_allocations($1)
        ) o ${order}`, [companyId, asOf]),
      claimsTx.unsafe(`select ${cols} from accounting.open_items($1, $2::date) ${order}`, [companyId, asOf]),
    ]);
    const claims = companyId === h.companyId ? h.admin.claims : await demoAdminClaims();
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...claims })}, true), set_config('role', 'authenticated', true)`;
    const [before, after, beforeAll, afterAll] = await run(tx);
    throw Object.assign(ROLLBACK, { result: { before, after, beforeAll, afterAll } });
  }).catch((e: unknown) => (e === ROLLBACK ? (ROLLBACK as Error & { result: unknown }).result : Promise.reject(e)));
  return seen as { before: unknown[]; after: unknown[]; beforeAll: unknown[]; afterAll: unknown[] };
}

describe("(1) the peso figures are 0138's", () => {
  it("on a peso ledger with invoices, a credit note, receipts (one voided) and an advance", async () => {
    const party = await newCustomer("Distribuidora Peso Uno S.A.S.");
    const a = await h.issuedInvoice(2, { partyId: party });
    const b = await h.issuedInvoice(3, { partyId: party });
    await h.receive({ partyId: party, amount: 150000, allocations: [{ invoiceId: a.id, amount: 100000 }, { invoiceId: b.id, amount: 50000 }] });
    const voided = await h.receive({ partyId: party, amount: 20000, allocations: [{ invoiceId: b.id, amount: 20000 }] });
    await h.runStepUp("payments.payment.void", { id: voided.id, reason: "Consignación duplicada" });
    const [line] = await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${a.id} order by line_no`;
    const note = await h.run<{ id: string }>(h.admin, "invoicing.note.create", { invoiceId: a.id, kind: "credit", concept: "1", reason: "Devolución parcial", lines: [{ invoiceLineId: line!.id, qty: 1 }] });
    await h.run(h.admin, "invoicing.note.issue", { id: note.id });
    await h.receive({ partyId: party, amount: 30000, allocations: [] });
    const { before, after, beforeAll, afterAll } = await compareWith0138(h.companyId, h.today);
    expect(before.length).toBeGreaterThan(0);
    expect(after).toEqual(before);
    expect(afterAll).toEqual(beforeAll);
  });

  it.skipIf(process.env.DEMO_SEED !== "1")("on the demo ledger of Café del Norte (DEMO_SEED=1, after pnpm db:seed)", async () => {
    for (const asOf of ["2026-10-31", h.today]) {
      const { before, after, beforeAll, afterAll } = await compareWith0138(DEMO_COMPANY_ID, asOf);
      expect(before.length).toBeGreaterThan(0);
      expect(after).toEqual(before);
      expect(afterAll).toEqual(beforeAll);
    }
  });

  it("a peso item answers its own currency, with the document figures equal to the company ones", async () => {
    const party = await newCustomer("Distribuidora Peso Dos S.A.S.");
    const invoice = await h.issuedInvoice(1, { partyId: party });
    await h.receive({ partyId: party, amount: 19000, allocations: [{ invoiceId: invoice.id, amount: 19000 }] });
    const item = itemOf(await openItems(party), await invoiceEntry(invoice.id))!;
    expect(item).toMatchObject({ currency: "COP", original: 119000, open: 100000, amount_doc: 119000, open_doc: 100000 });
  });
});

describe("(2) a COP receipt settling two USD invoices at different rates", () => {
  it("splits the receivable line by amount_company: each invoice is open 0 in dollars and in pesos", async () => {
    const party = await newCustomer("Northwind Split LLC");
    const first = await foreignInvoice(party, 1, 1000, 4100);
    const second = await foreignInvoice(party, 1, 1000, 4300);
    const receipt = await h.receive({
      partyId: party, amount: 8450000, method: "transfer",
      allocations: [{ invoiceId: first.id, amount: 1000, amountReceipt: 4200000 }, { invoiceId: second.id, amount: 1000, amountReceipt: 4250000 }],
    });
    expect(receipt.allocations.map((a) => a.amountCompany)).toEqual([4100000, 4300000]);
    const items = await openItems(party);
    expect(itemOf(items, await invoiceEntry(first.id))).toMatchObject({ currency: "USD", original: 4100000, open: 0, amount_doc: 1000, open_doc: 0 });
    expect(itemOf(items, await invoiceEntry(second.id))).toMatchObject({ currency: "USD", original: 4300000, open: 0, amount_doc: 1000, open_doc: 0 });
    expect(items.filter((i) => i.kind !== "document" && i.open !== 0)).toEqual([]);
  });
});

describe("(3) open_doc is the invoice less its allocations and its notes, in dollars", () => {
  it("USD 1.000 at 4.100, a credit note of USD 200 and a USD receipt of USD 300 at 4.000 leave USD 500 and $ 2.050.000 open", async () => {
    const party = await newCustomer("Northwind Notes LLC");
    const invoice = await foreignInvoice(party, 10, 100, 4100);
    const [line] = await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoice.id} order by line_no`;
    // The note follows its invoice (an export, OD-7): the buyer is abroad while it is written and issued, as for the invoice.
    await h.sql`update core.parties set country_code = 'US', department_code = null, municipality_code = null where id = ${party}`;
    try {
      const note = await h.run<{ id: string }>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "credit", concept: "1", reason: "Devolución parcial", lines: [{ invoiceLineId: line!.id, qty: 2 }] });
      await h.run(h.admin, "invoicing.note.issue", { id: note.id });
    } finally {
      await h.sql`update core.parties set country_code = 'CO', department_code = '11', municipality_code = '11001' where id = ${party}`;
    }
    await h.receive({ partyId: party, amount: 300, methodId: usdMethod, currency: "USD", exchangeRate: 4000, allocations: [{ invoiceId: invoice.id, amount: 300 }] });
    const item = itemOf(await openItems(party), await invoiceEntry(invoice.id))!;
    expect(item).toMatchObject({ currency: "USD", original: 4100000, amount_doc: 1000, open: 2050000, open_doc: 500 });
  });
});
