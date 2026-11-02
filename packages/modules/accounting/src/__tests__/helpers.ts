import { randomUUID } from "node:crypto";
import { ATTACHMENT_PROCESSES, CUSTOM_FIELD_PROCESSES, kernelModule, loadModules, registerCountryPack, Registry, runProcess, type Caller, type RunProcessDeps } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { accounting } from "../index";

export type Db = ReturnType<typeof testDb>;

/** Every process the accounting module declares, plus the kernel attachment and custom field processes the record forms use. */
export const ACCOUNTING_PROCESS_IDS = [...accounting.processes, ...ATTACHMENT_PROCESSES, ...CUSTOM_FIELD_PROCESSES].map((p) => p.id);

/** The consult processes and the entry processes (create, update, void, submit, post, from_template) a `contador` or `auxiliar` role may run. */
export const MEMBER_PROCESS_IDS = accounting.processes
  .filter((p) => p.kind === "consult" || /^accounting\.(entry|entry_template|entry_line)\./.test(p.id) || p.id === "accounting.opening.create")
  .map((p) => p.id);

/** Every accounting table, children first: the harness empties them for its companies. */
export const ACCOUNTING_TABLES = [
  "skipped_events", "period_close_checks", "posting_failures", "entry_template_lines", "entry_templates", "entry_lines", "entries",
  "posting_rules", "fiscal_concept_mappings", "account_permissions", "account_role_mappings", "settings", "periods", "fiscal_years",
  "journals", "cost_centers", "open_auxiliaries", "items", "business_units", "accounts",
];

type Member = { claims: JwtClaims; origin: "ui"; userId: string; roleId: string };

export interface AccountingHarness {
  sql: Db;
  deps: RunProcessDeps;
  seed: SeededTenant;
  /** Admin of company 0 (user `both`), active in company 0. */
  admin: { claims: JwtClaims; origin: "ui" };
  /** A member holding the `contador` role: consults and entries. */
  contador: Member;
  /** A member holding the `auxiliar` role: consults and entries. */
  auxiliar: Member;
  companyId: string;
  /** The caller with a fresh step-up verification (one use) for the process it runs next. */
  stepUp: (caller: Caller) => Promise<Caller>;
  /** `runProcess` as `caller`. */
  run: <T = unknown>(caller: Caller, processId: string, input: unknown) => Promise<T>;
  /** `runProcess` as `caller` with a fresh step-up verification. */
  runStepUp: <T = unknown>(caller: Caller, processId: string, input: unknown) => Promise<T>;
  /** Service-role grant of every listed process to the role, in the role's company. */
  grantAll: (companyId: string, roleId: string, ids: string[]) => Promise<void>;
  /** Removes every accounting and core row and kernel grant of the seeded companies, then the tenant. */
  cleanup: () => Promise<void>;
}

/**
 * Seeds a tenant entitled to `module:core` and `module:accounting` with `companies` companies, registers core and accounting in a
 * fresh registry and the Colombian pack, grants the admin role of every company all accounting processes, and creates the
 * `contador` and `auxiliar` roles (with their users) with the consult and entry processes.
 */
export async function accountingHarness(options: { companies?: number } = {}): Promise<AccountingHarness> {
  const sql = testDb();
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting]);
  registerCountryPack(co);
  const seed = await seedTenant(sql, {
    companies: options.companies ?? 1,
    users: [
      { name: "contador", companies: [0], role: "member" },
      { name: "auxiliar", companies: [0], role: "member" },
    ],
    entitlements: ["module:core", "module:accounting"],
  });
  const grantAll = async (companyId: string, roleId: string, ids: string[]) => {
    for (const id of ids) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
                values (${companyId}, ${roleId}, ${id}) on conflict (company_id, role_id, process_id) do nothing`;
    }
  };
  for (const company of seed.companies) await grantAll(company.id, company.adminRoleId, ACCOUNTING_PROCESS_IDS);
  const companyId = seed.companies[0]!.id;
  const companyIds = seed.companies.map((c) => c.id);

  const member = async (name: "contador" | "auxiliar"): Promise<Member> => {
    const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, ${name}, false) returning id`;
    const userId = seed.users[name]!;
    await seed.holdRoles(userId, companyId, [role!.id]);
    await grantAll(companyId, role!.id, MEMBER_PROCESS_IDS);
    // The claims carry the custom role only: the member is not the company admin.
    return { claims: { ...seed.claimsFor(userId, companyId), role_ids: [role!.id] }, origin: "ui", userId, roleId: role!.id };
  };
  const contador = await member("contador");
  const auxiliar = await member("auxiliar");

  const deps = { sql, registry };
  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${companyId}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };

  return {
    sql,
    deps,
    stepUp,
    run: <T>(caller: Caller, processId: string, input: unknown) => runProcess(deps, caller, processId, input) as Promise<T>,
    runStepUp: async <T>(caller: Caller, processId: string, input: unknown) => runProcess(deps, await stepUp(caller), processId, input) as Promise<T>,
    seed,
    admin: { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" },
    contador,
    auxiliar,
    companyId,
    grantAll,
    async cleanup() {
      // Replica role: no triggers (the append-only close checks refuse deletes) and no foreign key checks, so order does not matter.
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        // A table a later migration has not created yet is skipped, so the harness works from the first accounting migration on.
        for (const table of ACCOUNTING_TABLES) {
          const [found] = await tx<{ present: boolean }[]>`select to_regclass(${`accounting.${table}`}) is not null as present`;
          if (found!.present) await tx`delete from ${tx(`accounting.${table}`)} where company_id = any(${companyIds}::uuid[])`;
        }
        for (const table of ["price_list_items", "price_lists", "party_contacts", "products", "product_categories", "parties", "document_sequences", "entity_sequences"]) {
          await tx`delete from ${tx(`core.${table}`)} where company_id = any(${companyIds}::uuid[])`;
        }
      });
      await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
      await seed.cleanup();
      await sql.end();
    },
  };
}

/** A fresh uuid for fixtures that need an id no row has. */
export const newId = () => randomUUID();

/**
 * Makes a party `invoice_ready` the way a real one becomes so (rule 10, design §5.17): its DIAN data is complete and it
 * holds the files its kind requires (RUT for every party, Cámara de Comercio for a juridical one, person type `1`). The
 * party's own triggers compute the flag from these facts; a flagged account then accepts the party.
 */
export async function markInvoiceReady(h: AccountingHarness, partyId: string, personType: string): Promise<void> {
  await h.sql`update core.parties set dian_status = 'complete' where id = ${partyId}`;
  const tags = personType === "1" ? ["RUT", "Cámara de Comercio"] : ["RUT"];
  for (const tag of tags) {
    await h.sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
      values (${h.companyId}, 'core.party', ${partyId}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024,
        ${`${h.seed.tenantId}/${h.companyId}/core.party/${partyId}/${randomUUID()}-${tag}.pdf`})`;
  }
}
