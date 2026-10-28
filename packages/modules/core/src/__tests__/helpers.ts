import { randomUUID } from "node:crypto";
import { ATTACHMENT_PROCESSES, kernelModule, loadModules, registerCountryPack, Registry, type RunProcessDeps } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "../index";

export type Db = ReturnType<typeof testDb>;

/** Every process the core module declares, plus the kernel attachment processes the record forms use. */
export const CORE_PROCESS_IDS = [...core.processes, ...ATTACHMENT_PROCESSES].map((p) => p.id);

export interface CoreHarness {
  sql: Db;
  deps: RunProcessDeps;
  seed: SeededTenant;
  /** Admin of company 0 (user `both`), active in company 0. */
  admin: { claims: JwtClaims; origin: "ui" };
  companyId: string;
  /** Service-role grant of every listed process to the role, in the role's company. */
  grantAll: (companyId: string, roleId: string, ids: string[]) => Promise<void>;
  /** Removes every core row and kernel grant of the seeded companies, then the tenant. */
  cleanup: () => Promise<void>;
}

/**
 * Seeds a tenant entitled to `module:core` with `companies` companies, registers the core module in a
 * fresh registry and the Colombian pack, and grants the admin role of every company all core processes.
 */
export async function coreHarness(options: { companies?: number; users?: Parameters<typeof seedTenant>[1]["users"] } = {}): Promise<CoreHarness> {
  const sql = testDb();
  const registry = new Registry();
  loadModules(registry, [kernelModule, core]);
  registerCountryPack(co);
  const seed = await seedTenant(sql, { companies: options.companies ?? 1, users: options.users, entitlements: ["module:core"] });
  const grantAll = async (companyId: string, roleId: string, ids: string[]) => {
    for (const id of ids) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
                values (${companyId}, ${roleId}, ${id}) on conflict (company_id, role_id, process_id) do nothing`;
    }
  };
  for (const company of seed.companies) await grantAll(company.id, company.adminRoleId, CORE_PROCESS_IDS);
  const companyId = seed.companies[0]!.id;
  const companyIds = seed.companies.map((c) => c.id);
  return {
    sql,
    deps: { sql, registry },
    seed,
    admin: { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" },
    companyId,
    grantAll,
    async cleanup() {
      // Children first; audit rows are append-only and stay.
      for (const table of ["price_list_items", "price_lists", "party_contacts", "products", "product_categories", "parties", "document_sequences", "entity_sequences"]) {
        await sql`delete from ${sql(`core.${table}`)} where company_id = any(${companyIds}::uuid[])`;
      }
      await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
      await seed.cleanup();
      await sql.end();
    },
  };
}

/**
 * Stores a file against a record as the service role (the attachment triggers keep `invoice_ready` current),
 * for tests whose subject is not the attachment processes themselves.
 */
export async function attachFile(
  sql: Db,
  seed: { tenantId: string; companyId: string; entity: string; recordId: string; tag: string; fileName?: string; mimeType?: string },
): Promise<void> {
  const fileName = seed.fileName ?? `${seed.tag}.pdf`;
  await sql`insert into kernel.attachments(company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
            values (${seed.companyId}, ${seed.entity}, ${seed.recordId}, ${seed.tag}, ${fileName}, ${seed.mimeType ?? "application/pdf"}, 1024,
                    ${`${seed.tenantId}/${seed.companyId}/${seed.entity}/${seed.recordId}/${randomUUID()}-${fileName}`})`;
}

/** A domestic juridical customer with every DIAN datum present. */
export const exito = {
  kind: ["customer"],
  personType: "1",
  documentType: "31",
  documentNumber: "900373115",
  legalName: "Supermercados Éxito",
  taxResponsibilities: ["O-13"],
  taxScheme: "01",
  countryCode: "CO",
  departmentCode: "11",
  municipalityCode: "11001",
  addressLine: "Cra 1 # 2-3",
  invoiceEmail: "fe@exito.com",
};

/** A complete domestic supplier with document number `documentNumber`. */
export const supplier = (documentNumber: string) => ({
  ...exito,
  kind: ["supplier"],
  documentNumber,
  legalName: `Proveedor ${documentNumber} S.A.S.`,
  invoiceEmail: undefined,
  supplierEmail: "compras@proveedor.co",
});
