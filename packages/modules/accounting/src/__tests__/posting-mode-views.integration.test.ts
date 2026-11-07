import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postingModeHarness, type Harness } from "./posting-mode-harness";

// The two views the web layer reads (plan 2B Task 33 stage B, migration 0129; rule 14): `accounting.v_pending_postings` (over the definer function)
// and `accounting.v_posting_mode` (the one column the mode card shows to whoever reads the mapping). Both are security_invoker, refuse anon,
// show a member of the company its own rows and company B's user nothing of company A's.

let h: Harness;
beforeAll(async () => {
  h = await postingModeHarness();
  await h.setMode("asynchronous");
}, 300_000);
afterAll(async () => {
  await h?.cleanup();
});

/** Runs `fn` as an authenticated session of `claims`' user (company active), rolled back. */
async function asAuthenticated<T>(claims: object, fn: (tx: typeof h.sql) => Promise<T>): Promise<T> {
  const rollback = new Error("rollback");
  let out: T | undefined;
  await h.sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...claims })}, true), set_config('role', 'authenticated', true)`;
    out = await fn(tx as unknown as typeof h.sql);
    throw rollback;
  }).catch((e: unknown) => {
    if (e !== rollback) throw e;
  });
  return out as T;
}

describe("accounting.v_pending_postings and accounting.v_posting_mode", () => {
  it("are security_invoker views with no grant to anon or public", async () => {
    const rows = await h.sql<{ name: string; options: string[] | null; anon: boolean; authenticated: boolean }[]>`
      select c.relname as name, c.reloptions as options, has_table_privilege('anon', c.oid, 'select') as anon, has_table_privilege('authenticated', c.oid, 'select') as authenticated
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'accounting' and c.relname in ('v_pending_postings', 'v_posting_mode') order by 1`;
    expect(rows).toEqual([
      { name: "v_pending_postings", options: ["security_invoker=true"], anon: false, authenticated: true },
      { name: "v_posting_mode", options: ["security_invoker=true"], anon: false, authenticated: true },
    ]);
  });

  it("refuse an anonymous session", async () => {
    for (const view of ["v_pending_postings", "v_posting_mode"]) {
      const anon = h.sql.begin(async (tx) => {
        await tx`select set_config('role', 'anon', true)`;
        return tx.unsafe(`select * from accounting.${view}`);
      });
      await expect(anon, view).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("show a member of the company its own rows, and company B's user nothing of company A's", async () => {
    const invoice = await h.issuedInvoice();
    // A plain member of company A (no accounting process) reads the mode and the queued document.
    const own = await asAuthenticated(h.member.claims, async (tx) => ({
      mode: await tx`select company_id, posting_mode from accounting.v_posting_mode`,
      pending: await tx`select source_id, state from accounting.v_pending_postings where source_id = ${invoice.id}`,
    }));
    expect(own.mode).toEqual([{ company_id: h.companyId, posting_mode: "asynchronous" }]);
    expect(own.pending).toEqual([{ source_id: invoice.id, state: "queued" }]);
    // The same user active in company B sees none of it.
    const foreign = await asAuthenticated(h.otherAdmin.claims, async (tx) => ({
      mode: await tx`select * from accounting.v_posting_mode`,
      pending: await tx`select * from accounting.v_pending_postings where source_id = ${invoice.id}`,
      all: await tx`select * from accounting.v_pending_postings`,
    }));
    expect(foreign.mode).toEqual([]);
    expect(foreign.pending).toEqual([]);
    expect((foreign.all as unknown as { source_id: string }[]).filter((r) => r.source_id === invoice.id)).toEqual([]);
    expect(await h.drain()).toEqual([]);
  });
});
