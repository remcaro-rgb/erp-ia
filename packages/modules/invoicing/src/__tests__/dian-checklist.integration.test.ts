import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySecretStore } from "@erp/infra";
import { registerCountryPack, setSecretStore, type Caller, type Tx } from "@erp/kernel";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { generateTestCertP12 } from "../../../../localization/co/src/__tests__/helpers/test-cert";
import { invoicingHarness, tickAllAndConfirm, type Harness } from "./helpers";

// The DIAN verification checklist (plan 2B Task 35, owner item 20; R35-1..R35-15): the 24 values the documents carry (23 of item 20, moneda_extranjera of Task 34.4) that the DIAN may still ask
// to change, ticked one by one by the company's admin against the DIAN habilitación; the confirmation of the defaults (the flag the
// production guard of Task 19 reads) is possible only with every item ticked, is cleared by unticking any, and stops being effective when
// the list grows. Everything goes through processes (step-up, admin only, never an assistant tool); the database holds the same rules.

let h: Harness;
let secrets: InMemorySecretStore;
const NIT = "900373115";
const ITEMS = einvoicePack.dianChecklist.items;
const VERSION = einvoicePack.dianChecklist.version;
const NEW_KEY = "extra_value_for_the_test";

interface Consulted { version: number; storedVersion: number | null; confirmed: boolean; progress: { done: number; total: number }; items: { key: string; group: string; es: string; en: string; ticked: boolean; tickedBy: string | null; tickedAt: string | null; isNew: boolean }[] }
const tick = <T = unknown>(items: { itemKey: string; ticked: boolean }[], caller?: Caller) => h.runStepUp<T>("invoicing.dian_checklist.tick", { items }, caller);
const tickAll = (ticked = true) => tick(ITEMS.map((i) => ({ itemKey: i.key, ticked })));
const confirm = <T = unknown>(confirmed: boolean) => h.runStepUp<T>("invoicing.dian_defaults.confirm", { confirmed });
const consult = () => h.run<Consulted>(h.admin, "invoicing.dian_checklist.consult", {});
const settings = async () => (await h.sql<Record<string, unknown>[]>`select * from invoicing.settings where company_id = ${h.companyId}`)[0]!;
const check = async (key: string) => (await h.sql<Record<string, unknown>[]>`select * from invoicing.dian_checks where company_id = ${h.companyId} and item_key = ${key}`)[0];
/** A statement as the caller's database user (what PostgREST would run), optionally inside a process id (as a registered process's run sets it). */
const asUser = <T>(caller: Caller, statement: (tx: Tx) => Promise<T>, processId = "") => h.sql.begin(async (tx) => {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify(caller.claims)}, true), set_config('role', 'authenticated', true), set_config('erp.audit_process_id', ${processId}, true)`;
  return statement(tx);
});
/** A pack whose list has one more item (since = version + 1): the list grew in a later release. */
const withGrownList = () => {
  const grown = { version: VERSION + 1, items: [...ITEMS, { key: NEW_KEY, group: "reference_tables", since: VERSION + 1, es: "Un valor nuevo que la DIAN pidió verificar", en: "A new value the DIAN asked to verify" }] };
  registerCountryPack({ ...co, einvoice: { ...einvoicePack, dianChecklist: grown as never } });
};
const withOriginalList = () => registerCountryPack({ ...co, einvoice: einvoicePack });
/** Back to a clean company: habilitación, nothing ticked, nothing confirmed. */
const reset = async () => {
  withOriginalList();
  await h.sql`update invoicing.settings set dian_environment = 'habilitacion' where company_id = ${h.companyId}`;
  const rows = await h.sql<{ item_key: string }[]>`select item_key from invoicing.dian_checks where company_id = ${h.companyId} and ticked and item_key = any(${ITEMS.map((i) => i.key)})`;
  if (rows.length > 0) await tick(rows.map((r) => ({ itemKey: r.item_key, ticked: false })));
  await h.sql`update invoicing.settings set dian_defaults_confirmed = false, dian_checklist_version = null where company_id = ${h.companyId}`;
};

beforeAll(async () => {
  h = await invoicingHarness();
  await h.sql`update kernel.companies set tax_id = ${NIT} where id = ${h.companyId}`;
  secrets = new InMemorySecretStore();
  setSecretStore(secrets);
}, 300_000);

afterAll(async () => {
  withOriginalList();
  setSecretStore(undefined);
  delete process.env.EINVOICE_TRANSPORT;
  await h.sql`delete from vault.secrets where name like ${`dian/${h.companyId}/%`}`;
  await h.cleanup();
});

describe("the list the screen shows", () => {
  it("consult: 24 items in 8 groups, none ticked, no one's name, the effective confirmation false", async () => {
    const out = await consult();
    expect(out).toMatchObject({ version: VERSION, storedVersion: null, confirmed: false, progress: { done: 0, total: 24 } });
    expect(out.items).toHaveLength(24);
    expect(out.items[0]).toMatchObject({ key: "credit_note_type_91", group: "notes_documents", ticked: false, tickedBy: null, tickedAt: null, isNew: false });
    expect(out.items.every((i) => i.es.length > 10 && i.en.length > 10)).toBe(true);
    const settingsOut = await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {});
    expect(settingsOut).toMatchObject({ dian_defaults_confirmed: false, dian_checklist_version: null, dian_checklist_current_version: VERSION });
  });
});

describe("confirm: only with every item ticked", () => {
  it("refuses dian_checklist_incomplete with the unticked texts for each of the 24 items left out in turn; the flag stays false", async () => {
    await tickAll(true);
    // Every row that applies: lotes_en_xml (Task 28.4) only while dian_item_instance is on, and it is off here.
    for (const item of ITEMS.filter((i) => !i.when)) {
      await tick([{ itemKey: item.key, ticked: false }]);
      const refused = await h.refusal(confirm(true));
      expect(refused, item.key).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_checklist_incomplete/) });
      expect(JSON.stringify(refused!.details), item.key).toContain(item.es);
      expect((await settings()).dian_defaults_confirmed, item.key).toBe(false);
      await tick([{ itemKey: item.key, ticked: true }]);
    }
  }, 300_000);

  it("with all ticked it sets the flag and the list version", async () => {
    expect(await confirm(true)).toMatchObject({ confirmed: true, version: VERSION });
    expect(await settings()).toMatchObject({ dian_defaults_confirmed: true, dian_checklist_version: VERSION });
    const out = await consult();
    expect(out).toMatchObject({ confirmed: true, storedVersion: VERSION, progress: { done: 24, total: 24 } });
    expect(out.items.every((i: { ticked: boolean; isNew: boolean; tickedBy: string | null }) => i.ticked && !i.isNew && typeof i.tickedBy === "string")).toBe(true);
    expect(await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {})).toMatchObject({ dian_defaults_confirmed: true, dian_checklist_version: VERSION });
  });

  it("unticking one clears the flag and the version in the same run, audited (item true→false, flag true→false) with actor, origin and chain", async () => {
    const before = await check("poll_backoff");
    const out = await tick<{ confirmationCleared: boolean; progress: { done: number; total: number } }>([{ itemKey: "poll_backoff", ticked: false }]);
    expect(out).toMatchObject({ confirmationCleared: true, progress: { done: 23, total: 24 } });
    expect(await settings()).toMatchObject({ dian_defaults_confirmed: false, dian_checklist_version: null });
    const itemAudit = await h.sql<{ before: string; after: string; actor: string; origin: string; chain_id: string; process_id: string }[]>`
      select diff->'ticked'->>'old' as before, diff->'ticked'->>'new' as after, actor_user_id as actor, origin, chain_id, process_id from kernel.audit_log
      where row_id = ${before!.id as string} and entity = 'invoicing.dian_checks' and action = 'update' order by occurred_at desc, id desc limit 1`;
    expect(itemAudit[0]).toMatchObject({ before: "true", after: "false", actor: h.admin.claims.sub, origin: "ui", process_id: "invoicing.dian_checklist.tick" });
    const flagAudit = await h.sql<{ before: string; after: string; chain_id: string; version_after: string | null }[]>`
      select diff->'dian_defaults_confirmed'->>'old' as before, diff->'dian_defaults_confirmed'->>'new' as after, chain_id, diff->'dian_checklist_version'->>'new' as version_after from kernel.audit_log
      where row_id = ${(await settings()).id as string} and entity = 'invoicing.settings' and action = 'update' and diff ? 'dian_defaults_confirmed' order by occurred_at desc, id desc limit 1`;
    expect(flagAudit[0]).toMatchObject({ before: "true", after: "false", version_after: null });
    expect(flagAudit[0]!.chain_id).toBe(itemAudit[0]!.chain_id);
    await tick([{ itemKey: "poll_backoff", ticked: true }]);
  });
});

describe("ticks: who and when, audited; a repeat writes nothing", () => {
  it("a tick stores the user and the time and audits the change; an untick clears both; a repeated tick changes no row and writes no audit", async () => {
    await reset();
    const started = (await h.sql<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now;
    const out = await tick<{ items: { itemKey: string; ticked: boolean; tickedBy: string | null; tickedAt: string | null }[]; confirmationCleared: boolean }>([{ itemKey: "no_sts_qrcode", ticked: true }]);
    const finished = (await h.sql<{ now: Date }[]>`select clock_timestamp() as now`)[0]!.now;
    expect(out.confirmationCleared).toBe(false);
    expect(out.items).toEqual([expect.objectContaining({ itemKey: "no_sts_qrcode", ticked: true })]);
    const row = (await check("no_sts_qrcode"))!;
    expect(row).toMatchObject({ ticked: true, ticked_by: h.admin.claims.sub });
    expect((row.ticked_at as Date).getTime()).toBeGreaterThanOrEqual(started.getTime());
    expect((row.ticked_at as Date).getTime()).toBeLessThanOrEqual(finished.getTime());
    const audits = () => h.sql<{ action: string; actor: string; origin: string; chain_id: string; diff: Record<string, { old: unknown; new: unknown }> }[]>`
      select action, actor_user_id as actor, origin, chain_id, diff from kernel.audit_log where row_id = ${row.id as string} and entity = 'invoicing.dian_checks' order by occurred_at, id`;
    const afterTick = await audits();
    // (The row exists from the tests before: this tick is its next change, with the user and the time in the diff.)
    const base = afterTick.length;
    expect(afterTick[base - 1]).toMatchObject({ action: expect.stringMatching(/insert|update/), actor: h.admin.claims.sub, origin: "ui" });
    expect(afterTick[base - 1]!.diff.ticked).toEqual({ old: base > 1 ? false : null, new: true });
    expect(afterTick[base - 1]!.diff.ticked_by!.new).toBe(h.admin.claims.sub);
    // The same tick again: no row changes, no audit.
    const again = await tick<{ items: unknown[] }>([{ itemKey: "no_sts_qrcode", ticked: true }]);
    expect(again.items).toEqual([expect.objectContaining({ itemKey: "no_sts_qrcode", ticked: true })]);
    expect(await audits()).toHaveLength(base);
    expect((await check("no_sts_qrcode"))!.updated_at).toEqual(row.updated_at);
    // Untick: who and when are cleared, and the row's audit shows before and after.
    await tick([{ itemKey: "no_sts_qrcode", ticked: false }]);
    expect(await check("no_sts_qrcode")).toMatchObject({ ticked: false, ticked_by: null, ticked_at: null });
    const trail = await audits();
    expect(trail).toHaveLength(base + 1);
    expect(trail[base]).toMatchObject({ action: "update", actor: h.admin.claims.sub, origin: "ui" });
    expect(trail[base]!.diff.ticked).toEqual({ old: true, new: false });
    expect(trail[base]!.diff.ticked_by!.old).toBe(h.admin.claims.sub);
    // The row is kept (nothing is deleted), even by the service connection.
    await expect(h.sql`delete from invoicing.dian_checks where id = ${row.id as string}`).rejects.toThrow(/no se elimina|dian_check/);
  });

  it("one run ticks several items under one step-up code and one transaction; a refused one leaves none", async () => {
    await reset();
    const out = await tick<{ items: unknown[]; progress: { done: number } }>([{ itemKey: "credit_note_type_91", ticked: true }, { itemKey: "export_customization_10", ticked: true }]);
    expect(out.items).toHaveLength(2);
    expect(out.progress.done).toBe(2);
    await expect(h.refusal(tick([{ itemKey: "poll_backoff", ticked: true }, { itemKey: "no_such_item", ticked: true }]))).resolves.toMatchObject({ code: "invalid_input" });
    expect((await check("poll_backoff"))?.ticked ?? false).toBe(false);
  });

  it("an unknown key, a duplicate key, no items and more than fifty are refused invalid_input", async () => {
    expect(await h.refusal(tick([{ itemKey: "no_such_item", ticked: true }]))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(tick([{ itemKey: "poll_backoff", ticked: true }, { itemKey: "poll_backoff", ticked: false }]))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(tick([]))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(tick(Array.from({ length: 51 }, (_, i) => ({ itemKey: `k${i}`, ticked: true }))))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(h.runStepUp("invoicing.dian_checklist.tick", { items: [{ itemKey: "poll_backoff", ticked: true, extra: 1 }] }))).toMatchObject({ code: "invalid_input" });
  });
});

describe("the list grows (R35-7, R35-8)", () => {
  it("a new item makes the confirmation ineffective at once: consult shows it and isNew, producción is refused naming the count, confirm waits for the new item", async () => {
    await reset();
    await tickAllAndConfirm(h);
    expect((await consult()).confirmed).toBe(true);
    withGrownList();
    try {
      const out = await consult();
      expect(out).toMatchObject({ version: VERSION + 1, storedVersion: VERSION, confirmed: false, progress: { done: 24, total: 25 } });
      expect(out.items.filter((i: { isNew: boolean }) => i.isNew).map((i: { key: string }) => i.key)).toEqual([NEW_KEY]);
      expect(await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {})).toMatchObject({ dian_defaults_confirmed: false, dian_checklist_version: VERSION, dian_checklist_current_version: VERSION + 1 });
      // The stored flag lags (nothing ran), the effective one does not.
      expect((await settings()).dian_defaults_confirmed).toBe(true);
      expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_defaults_unconfirmed.*el valor pendiente/s) });
      expect(await h.refusal(confirm(true))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_checklist_incomplete/) });
      await tick([{ itemKey: NEW_KEY, ticked: true }]);
      expect(await confirm(true)).toMatchObject({ confirmed: true, version: VERSION + 1 });
      expect((await consult()).confirmed).toBe(true);
      // Unticking the new item clears it again (before the original list is back, which does not know the key).
      await tick([{ itemKey: NEW_KEY, ticked: false }]);
    } finally {
      withOriginalList();
    }
    expect(await consult()).toMatchObject({ confirmed: false, progress: { done: 24, total: 24 } });
  });
});

describe("a stale confirmation is lowered by the next run (R35-7, I1)", () => {
  it("after a version bump in habilitación, a tick of the new item lowers the stored flag and version, audited, confirmationCleared true", async () => {
    await reset();
    await tickAllAndConfirm(h);
    withGrownList();
    try {
      expect((await settings()).dian_defaults_confirmed).toBe(true);
      const out = await tick<{ confirmationCleared: boolean }>([{ itemKey: NEW_KEY, ticked: true }]);
      expect(out.confirmationCleared).toBe(true);
      expect(await settings()).toMatchObject({ dian_defaults_confirmed: false, dian_checklist_version: null });
      const audit = await h.sql<{ before: string; after: string; process_id: string }[]>`
        select diff->'dian_defaults_confirmed'->>'old' as before, diff->'dian_defaults_confirmed'->>'new' as after, process_id from kernel.audit_log
        where row_id = ${(await settings()).id as string} and entity = 'invoicing.settings' and diff ? 'dian_defaults_confirmed' order by occurred_at desc, id desc limit 1`;
      expect(audit[0]).toMatchObject({ before: "true", after: "false", process_id: "invoicing.dian_checklist.tick" });
      // Ticked all, confirm again works at the new version.
      expect(await confirm(true)).toMatchObject({ confirmed: true, version: VERSION + 1 });
      await tick([{ itemKey: NEW_KEY, ticked: false }]);
    } finally {
      withOriginalList();
    }
  });

  it("a confirm that finds a stale stamp re-stamps it at the current version (and never leaves the old one)", async () => {
    await reset();
    await tickAllAndConfirm(h);
    await h.sql`update invoicing.settings set dian_checklist_version = ${VERSION + 5} where company_id = ${h.companyId}`;
    expect(await confirm(true)).toMatchObject({ confirmed: true, version: VERSION });
    expect((await settings()).dian_checklist_version).toBe(VERSION);
  });
});

describe("confirm and untick serialise on the settings row (I2)", () => {
  it("interleaved, the end state is never a confirmation at a version with an unticked item", async () => {
    for (let i = 0; i < 8; i++) {
      await reset();
      await tickAll(true);
      await Promise.allSettled([confirm(true), tick([{ itemKey: "poll_backoff", ticked: false }])]);
      const s = await settings();
      const unticked = (await check("poll_backoff"))!.ticked === false;
      expect(unticked, `round ${i}`).toBe(true);
      expect(s.dian_defaults_confirmed, `round ${i}`).toBe(false);
      expect(s.dian_checklist_version, `round ${i}`).toBeNull();
    }
  }, 120_000);
});

describe("authorization", () => {
  it("tick and confirm ask for a fresh verification code (step-up)", async () => {
    expect(await h.refusal(h.run(h.admin, "invoicing.dian_checklist.tick", { items: [{ itemKey: "poll_backoff", ticked: true }] }))).toMatchObject({ code: "step_up_required" });
    expect(await h.refusal(h.run(h.admin, "invoicing.dian_defaults.confirm", { confirmed: true }))).toMatchObject({ code: "step_up_required" });
  });

  it("a member without the role matrix's grant, and a member whose role holds every process, are refused (admin only)", async () => {
    await reset();
    const input = { items: [{ itemKey: "poll_backoff", ticked: true }] };
    expect(await h.refusal(h.runStepUp("invoicing.dian_checklist.tick", input, h.member))).toMatchObject({ code: "forbidden" });
    const ids = ["invoicing.dian_checklist.tick", "invoicing.dian_defaults.confirm", "invoicing.dian_checklist.consult"];
    for (const id of ids) await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${h.memberRoleId}, ${id}) on conflict do nothing`;
    try {
      expect(await h.refusal(h.runStepUp("invoicing.dian_checklist.tick", input, h.member))).toMatchObject({ code: "forbidden", message: expect.stringMatching(/administrador/) });
      expect(await h.refusal(h.runStepUp("invoicing.dian_defaults.confirm", { confirmed: true }, h.member))).toMatchObject({ code: "forbidden" });
      expect(await h.refusal(h.run(h.member, "invoicing.dian_checklist.consult", {}))).toMatchObject({ code: "forbidden" });
    } finally {
      await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${h.memberRoleId} and process_id = any(${ids})`;
    }
    expect((await check("poll_backoff"))?.ticked ?? false).toBe(false);
  });

  it("the settings update no longer takes the flag (strict input): the confirmation is only the checklist's", async () => {
    expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianDefaultsConfirmed: true }))).toMatchObject({ code: "invalid_input" });
    expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianDefaultsConfirmed: false }))).toMatchObject({ code: "invalid_input" });
  });
});

describe("producción (Task 19's guard on top of the checklist)", () => {
  const cert = () => generateTestCertP12({ subjectNit: NIT, serial: "5a7e", cn: "CAFE DEL NORTE S.A.S." });

  it("is refused code dian_defaults_unconfirmed while the flag is unset, naming the pending count and the checklist", async () => {
    await reset();
    await tick([{ itemKey: "poll_backoff", ticked: true }]);
    const refused = await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }));
    expect(refused).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_defaults_unconfirmed/) });
    expect(refused!.message).toMatch(/23 valores pendientes/);
    expect(refused!.message).toMatch(/lista de verificación DIAN/);
    expect((await settings()).dian_environment).toBe("habilitacion");
  });

  it("with the checklist confirmed, a transport that serves producción, the software, the certificate and the PIN: producción; in producción an untick is refused and the flag stays", async () => {
    await reset();
    await tickAllAndConfirm(h);
    // Confirmed: the mock still cannot serve producción (the refusal is now the transport's, not the checklist's).
    delete process.env.EINVOICE_TRANSPORT;
    expect(await h.refusal(h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/einvoice_environment_mismatch/) });
    await h.runStepUp("invoicing.settings.update", { softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: NIT });
    await h.runStepUp("invoicing.software_pin.set", { pin: "75315" });
    const c = cert();
    await h.runStepUp("invoicing.certificate.upload", { file: c.buffer.toString("base64"), password: c.password });
    process.env.EINVOICE_TRANSPORT = "dian-produccion";
    try {
      expect(await h.runStepUp("invoicing.settings.update", { dianEnvironment: "produccion" })).toMatchObject({ dianEnvironment: "produccion" });
      expect(await h.refusal(tick([{ itemKey: "poll_backoff", ticked: false }]))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_in_production/) });
      expect(await h.refusal(confirm(false))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/dian_defaults_unconfirmed/) });
      expect(await settings()).toMatchObject({ dian_defaults_confirmed: true, dian_checklist_version: VERSION });
      expect((await check("poll_backoff"))!.ticked).toBe(true);
      // Ticking is still allowed there (nothing is withdrawn).
      expect(await tick([{ itemKey: "poll_backoff", ticked: true }])).toMatchObject({ confirmationCleared: false });

      // R35-8: the list grows while the company is in producción: the stored flag stays (0101 forbids lowering it), the confirmation is no
      // longer effective, the screen lists the new item, and nothing about operating changes.
      withGrownList();
      try {
        const out = await consult();
        expect(out).toMatchObject({ confirmed: false, storedVersion: VERSION, progress: { done: 24, total: 25 } });
        expect(out.items.filter((i: { isNew: boolean }) => i.isNew).map((i: { key: string }) => i.key)).toEqual([NEW_KEY]);
        expect((await settings()).dian_defaults_confirmed).toBe(true);
        expect(await h.runStepUp("invoicing.settings.update", { creditDays: 45 })).toMatchObject({ dianEnvironment: "produccion", creditDays: 45 });
        // Ticking the new item and confirming again re-stamps the version.
        await tick([{ itemKey: NEW_KEY, ticked: true }]);
        expect(await confirm(true)).toMatchObject({ confirmed: true, version: VERSION + 1 });
        // Back to habilitación is allowed; the checklist is then editable again.
        await h.runStepUp("invoicing.settings.update", { dianEnvironment: "habilitacion", creditDays: 30 });
        expect((await settings()).dian_environment).toBe("habilitacion");
        expect(await tick([{ itemKey: NEW_KEY, ticked: false }])).toMatchObject({ confirmationCleared: true });
      } finally {
        withOriginalList();
      }
    } finally {
      delete process.env.EINVOICE_TRANSPORT;
    }
  }, 180_000);
});

describe("a company already in producción before the checklist (M2, owner item 87)", () => {
  it("a migration-era row (producción, stamped version 1, no tick) can still save its other Parámetros", async () => {
    await reset();
    await h.sql`update invoicing.settings set dian_defaults_confirmed = true, dian_checklist_version = 1, dian_environment = 'produccion' where company_id = ${h.companyId}`;
    process.env.EINVOICE_TRANSPORT = "dian-produccion";
    try {
      expect((await consult()).confirmed).toBe(false);
      expect(await h.runStepUp("invoicing.settings.update", { creditDays: 40 })).toMatchObject({ dianEnvironment: "produccion", creditDays: 40 });
      await h.runStepUp("invoicing.settings.update", { dianEnvironment: "habilitacion", creditDays: 30 });
    } finally {
      delete process.env.EINVOICE_TRANSPORT;
    }
  });
});

describe("the database holds the same rules", () => {
  it("a user cannot write dian_checks or the flag by SQL; the service can; another company reads none of it", async () => {
    await reset();
    await tick([{ itemKey: "credit_note_type_91", ticked: true }]);
    const row = (await check("credit_note_type_91"))!;
    // A user outside the processes: the insert is refused by the restrictive policy, the update changes no row, the delete has no grant.
    await expect(asUser(h.admin, (tx) => tx`insert into invoicing.dian_checks (company_id, item_key, ticked, ticked_by, ticked_at) values (${h.companyId}, 'poll_backoff', true, ${h.admin.claims.sub}, now())`)).rejects.toThrow(/row-level security|permission denied/);
    const updated = await asUser(h.admin, (tx) => tx`update invoicing.dian_checks set ticked = false, ticked_by = null, ticked_at = null where id = ${row.id as string} returning id`);
    expect(updated).toHaveLength(0);
    expect((await check("credit_note_type_91"))!.ticked).toBe(true);
    await expect(asUser(h.admin, (tx) => tx`delete from invoicing.dian_checks where id = ${row.id as string}`)).rejects.toThrow(/permission denied/);
    // The flag: outside any process the update changes no row (the settings' via_process policy); inside another invoicing process (the
    // settings update, an assistant tool) the guard refuses; inside the two processes' ids it passes (PostgREST and SQL cannot bypass them).
    const flag = (tx: Tx) => tx`update invoicing.settings set dian_defaults_confirmed = true, dian_checklist_version = 1 where company_id = ${h.companyId} returning id`;
    expect(await asUser(h.admin, flag)).toHaveLength(0);
    await expect(asUser(h.admin, flag, "invoicing.settings.update")).rejects.toThrow(/invoicing\.dian_checklist\.tick and invoicing\.dian_defaults\.confirm/);
    await expect(asUser(h.admin, (tx) => tx`update invoicing.settings set dian_checklist_version = 1 where company_id = ${h.companyId}`, "invoicing.settings.update")).rejects.toThrow(/invoicing\.dian_defaults\.confirm/);
    await expect(asUser(h.admin, (tx) => tx`update invoicing.settings set dian_defaults_confirmed = false, dian_checklist_version = null where company_id = ${h.companyId}`, "invoicing.settings.update")).resolves.toBeDefined();
    await expect(asUser(h.admin, (tx) => tx`update invoicing.dian_checks set ticked = true where id = ${row.id as string}`, "invoicing.settings.update")).resolves.toBeDefined();
    expect((await check("credit_note_type_91"))!.ticked).toBe(true);
    expect((await settings()).dian_defaults_confirmed).toBe(false);
    // M3: only the tick process writes the ticks (not any process of the prefix); M8: the guard's INSERT branch.
    await expect(asUser(h.admin, (tx) => tx`insert into invoicing.dian_checks (company_id, item_key, ticked, ticked_by, ticked_at) values (${h.companyId}, 'poll_backoff', true, ${h.admin.claims.sub}, now())`, "invoicing.dian_checklist.consult")).rejects.toThrow(/row-level security/);
    expect(await asUser(h.admin, (tx) => tx`update invoicing.dian_checks set ticked = false, ticked_by = null, ticked_at = null where id = ${row.id as string} returning id`, "invoicing.dian_checklist.consult")).toHaveLength(0);
    await expect(asUser(h.admin, (tx) => tx`insert into invoicing.settings (company_id, dian_defaults_confirmed, dian_checklist_version) values (${h.otherCompanyId}, true, 1)`, "invoicing.settings.update")).rejects.toThrow(/invoicing\.dian_checklist\.tick and invoicing\.dian_defaults\.confirm|row-level security/);
    // A tick and its who and when go together.
    await expect(h.sql`update invoicing.dian_checks set ticked_by = null where id = ${row.id as string}`).rejects.toThrow(/dian_checks_check|check constraint/);
    await expect(h.sql`update invoicing.settings set dian_defaults_confirmed = true where company_id = ${h.companyId}`).rejects.toThrow(/settings_dian_checklist_version/);
    await expect(h.sql`update invoicing.settings set dian_checklist_version = 1 where company_id = ${h.companyId}`).rejects.toThrow(/settings_dian_checklist_version/);
    // The service connection (no user) passes the guard.
    await h.sql`update invoicing.settings set dian_defaults_confirmed = true, dian_checklist_version = 1 where company_id = ${h.companyId}`;
    await h.sql`update invoicing.settings set dian_defaults_confirmed = false, dian_checklist_version = null where company_id = ${h.companyId}`;
    // Company B reads neither the ticks nor the view's rows.
    const other: Caller = { claims: h.seed.claimsFor(h.seed.users.both, h.otherCompanyId) as never, origin: "ui" };
    expect(await asUser(other, (tx) => tx`select * from invoicing.dian_checks`)).toHaveLength(0);
    expect(await asUser(other, (tx) => tx`select * from invoicing.v_dian_checks`)).toHaveLength(0);
    expect(await asUser(h.admin, (tx) => tx`select * from invoicing.v_dian_checks`)).not.toHaveLength(0);
    expect((await h.run<Consulted>(h.admin, "invoicing.dian_checklist.consult", {})).items.filter((i: { ticked: boolean }) => i.ticked)).toHaveLength(1);
  });

  it("a role with ticked_by hidden reads it blank THROUGH THE VIEW; the consult is admin-only and the system admin always sees every field (rule 14)", async () => {
    await reset();
    await tick([{ itemKey: "credit_note_type_91", ticked: true }]);
    await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${h.memberRoleId}, 'invoicing.dian_check', 'ticked_by', 'hidden')`;
    try {
      const read = (caller: Caller) => asUser(caller, (tx) => tx<{ ticked: boolean; ticked_by: string | null; ticked_at: Date | null }[]>`select ticked, ticked_by, ticked_at from invoicing.v_dian_checks where item_key = 'credit_note_type_91'`);
      const [hidden] = await read(h.member);
      expect(hidden).toMatchObject({ ticked: true, ticked_by: null });
      expect(hidden!.ticked_at).not.toBeNull();
      expect((await read(h.admin))[0]!.ticked_by).toBe(h.admin.claims.sub);
      expect((await consult()).items.find((i: { key: string }) => i.key === "credit_note_type_91")).toMatchObject({ ticked: true, tickedBy: expect.any(String) });
    } finally {
      await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and entity = 'invoicing.dian_check'`;
    }
  });

  it("settings.consult keeps a hidden dian_defaults_confirmed hidden (null), whatever the effective value (rule 14)", async () => {
    await reset();
    await tickAllAndConfirm(h);
    await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${h.memberRoleId}, 'invoicing.settings.consult') on conflict do nothing`;
    await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${h.memberRoleId}, 'invoicing.settings', 'dian_defaults_confirmed', 'hidden')`;
    try {
      const out = await h.run<Record<string, unknown>>(h.member, "invoicing.settings.consult", {});
      expect(out.dian_defaults_confirmed).toBeNull();
      expect((await h.run<Record<string, unknown>>(h.admin, "invoicing.settings.consult", {})).dian_defaults_confirmed).toBe(true);
    } finally {
      await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and entity = 'invoicing.settings'`;
      await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${h.memberRoleId} and process_id = 'invoicing.settings.consult'`;
    }
  });

  it("migration 0135: a confirmed habilitación row loses the confirmation, a confirmed producción row is stamped version 1, and the new check ties the pair", async () => {
    const sqlText = readFileSync(new URL("../../../../../supabase/migrations/0135_invoicing_dian_checklist.sql", import.meta.url), "utf8");
    const updates = [...sqlText.matchAll(/^update invoicing\.settings[^;]+;/gm)].map((m) => m[0]);
    expect(updates).toHaveLength(2);
    await reset();
    await h.sql`insert into invoicing.settings (company_id) values (${h.otherCompanyId}) on conflict (company_id) do nothing`;
    const sentinel = new Error("rollback");
    await expect(h.sql.begin(async (tx) => {
      // The Task 19 era: the flag without a version (the new check dropped for the fixture), one company per environment.
      await tx`alter table invoicing.settings drop constraint settings_dian_checklist_version`;
      await tx`update invoicing.settings set dian_defaults_confirmed = true where company_id = ${h.companyId}`;
      await tx`update invoicing.settings set dian_defaults_confirmed = true, dian_environment = 'produccion', software_id = 'x', certificate_uploaded_at = now(), software_pin_set_at = now() where company_id = ${h.otherCompanyId}`;
      for (const statement of updates) await tx.unsafe(statement);
      const rows = await tx<{ company_id: string; confirmed: boolean; version: number | null }[]>`
        select company_id, dian_defaults_confirmed as confirmed, dian_checklist_version as version from invoicing.settings where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
      const by = Object.fromEntries(rows.map((r) => [r.company_id, r]));
      expect(by[h.companyId]).toMatchObject({ confirmed: false, version: null });
      expect(by[h.otherCompanyId]).toMatchObject({ confirmed: true, version: 1 });
      throw sentinel;
    })).rejects.toBe(sentinel);
  });
});
