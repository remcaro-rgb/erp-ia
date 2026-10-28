import "server-only";
import {
  loadCustomFields,
  matrixProcesses,
  moduleStates,
  readAiUsage,
  readPermissionMatrix,
  registeredVerifiers,
  withClaims,
  type AiUsage,
  type Caller,
  type CustomFieldRow,
  type MatrixProcess,
  type ModuleState,
  type PermissionMatrix,
  type Registry,
  type Tx,
} from "@erp/kernel";
import { requireCaller } from "@/lib/auth/claims";
import { processDeps, registrySynced } from "@/lib/server/runtime";

// What the administration screens show (design §6, prototype v5 "Administración"), read as the caller under RLS from
// the kernel's admin views: plain reads, not consult processes, so opening a screen asks for no step-up and writes no
// audit row (every change does both, through the kernel.admin.* processes in ./actions). Only the company admin
// (`kernel.is_company_admin()`) gets data; anyone else gets `null` and the screen says they may not administer.

export interface AdminRole {
  id: string;
  name: string;
  description: string;
  partyScope: string;
  isSystemAdmin: boolean;
}

export interface AdminMember {
  userId: string;
  name: string;
  email: string;
  mobileCc: string | null;
  mobile: string | null;
  photo: string | null;
  roleIds: string[];
  mfaEnrolled: boolean;
}

/** An entity of the modules the company uses, with the fields the visibility editor lists. */
export interface AdminEntity {
  id: string;
  module: string;
  label: string;
  fields: { name: string; label: string; confidential: boolean }[];
}

interface Admin {
  caller: Caller;
  registry: Registry;
}

/** Runs `read` as the caller when they are the company admin, else answers null. */
async function asAdmin<T>(read: (tx: Tx, admin: Admin) => Promise<T>): Promise<T | null> {
  const caller = await requireCaller();
  const deps = processDeps();
  await registrySynced();
  return withClaims(deps.sql, caller.claims, async (tx) => {
    const [row] = await tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
    if (!row?.admin) return null;
    return read(tx, { caller, registry: deps.registry });
  });
}

async function roles(tx: Tx): Promise<AdminRole[]> {
  const rows = await tx<{ id: string; name: string; description: string; party_scope: string; system_admin: boolean }[]>`
    select id, name, description, party_scope, is_system and name = 'admin' as system_admin
    from kernel.v_roles where company_id = kernel.current_company_id() order by is_system desc, created_at, id`;
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, partyScope: r.party_scope, isSystemAdmin: r.system_admin }));
}

async function members(tx: Tx): Promise<AdminMember[]> {
  const rows = await tx<
    { user_id: string; full_name: string | null; email: string; mobile_cc: string | null; mobile: string | null; photo: string | null; role_ids: string[]; mfa_enrolled: boolean | null }[]
  >`select user_id, full_name, email, mobile_cc, mobile, photo, role_ids, mfa_enrolled
    from kernel.v_memberships where company_id = kernel.current_company_id() order by full_name, email`;
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.full_name ?? r.email,
    email: r.email,
    mobileCc: r.mobile_cc,
    mobile: r.mobile,
    photo: r.photo,
    roleIds: r.role_ids,
    mfaEnrolled: r.mfa_enrolled === true,
  }));
}

/** The modules the company uses (the platform included). */
async function usableModules(tx: Tx, registry: Registry): Promise<Set<string>> {
  return new Set((await moduleStates(tx, registry)).filter((m) => m.enabled).map((m) => m.id));
}

/** The business entities (not the platform's own) of the modules the company uses. */
function businessEntities(registry: Registry, usable: Set<string>): AdminEntity[] {
  return registry
    .entities()
    .filter((e) => e.module !== "kernel" && usable.has(e.module))
    .map((e) => ({ id: e.id, module: e.module, label: e.label, fields: e.fields.map((f) => ({ name: f.name, label: f.label, confidential: f.sensitivity === "confidential" })) }));
}

export type PermissionsData = PermissionMatrix;

export const loadPermissions = (): Promise<PermissionsData | null> => asAdmin((tx, { caller, registry }) => readPermissionMatrix(tx, registry, caller.claims.active_company_id));

export interface RolesData {
  roles: (AdminRole & { permissions: number })[];
  members: AdminMember[];
}

export const loadRoles = (): Promise<RolesData | null> =>
  asAdmin(async (tx) => {
    const counts = await tx<{ role_id: string; n: string }[]>`
      select role_id, count(*) as n from kernel.v_process_permissions where company_id = kernel.current_company_id() and allowed group by role_id`;
    const byRole = new Map(counts.map((c) => [c.role_id, Number(c.n)]));
    return { roles: (await roles(tx)).map((r) => ({ ...r, permissions: byRole.get(r.id) ?? 0 })), members: await members(tx) };
  });

export interface UsersData {
  roles: AdminRole[];
  members: AdminMember[];
}

export const loadUsers = (): Promise<UsersData | null> => asAdmin(async (tx) => ({ roles: await roles(tx), members: await members(tx) }));

export interface FieldsData {
  roles: AdminRole[];
  entities: AdminEntity[];
  /** `entity.field` → role id → mode, as stored (no row: visible). */
  modes: Record<string, Record<string, string>>;
}

export const loadFields = (): Promise<FieldsData | null> =>
  asAdmin(async (tx, { registry }) => {
    const rows = await tx<{ role_id: string; entity: string; field: string; mode: string }[]>`
      select role_id, entity, field, mode from kernel.v_field_permissions where company_id = kernel.current_company_id()`;
    const modes: Record<string, Record<string, string>> = {};
    for (const row of rows) (modes[`${row.entity}.${row.field}`] ??= {})[row.role_id] = row.mode;
    return { roles: await roles(tx), entities: businessEntities(registry, await usableModules(tx, registry)), modes };
  });

export interface ExtraData {
  roles: AdminRole[];
  entities: (AdminEntity & { customFields: CustomFieldRow[] })[];
}

export const loadExtra = (): Promise<ExtraData | null> =>
  asAdmin(async (tx, { registry }) => {
    const entities = businessEntities(registry, await usableModules(tx, registry));
    const withFields = [];
    for (const entity of entities) withFields.push({ ...entity, customFields: await loadCustomFields(tx, entity.id) });
    return { roles: await roles(tx), entities: withFields };
  });

export interface RequiredFile {
  id: string;
  entity: string;
  tag: string;
  kind: "pdf" | "image" | "any";
  required: boolean;
  condition: string | null;
  description: string;
}

export interface RequiredFilesData {
  entities: AdminEntity[];
  files: RequiredFile[];
}

export const loadRequiredFiles = (): Promise<RequiredFilesData | null> =>
  asAdmin(async (tx, { registry }) => {
    const rows = await tx<{ id: string; entity: string; tag: string; kind: RequiredFile["kind"]; required: boolean; condition: string | null; description: string | null }[]>`
      select id, entity, tag, kind, required, condition, description from kernel.v_required_attachments
      where company_id = kernel.current_company_id() order by entity, tag`;
    return {
      entities: businessEntities(registry, await usableModules(tx, registry)),
      files: rows.map((r) => ({ ...r, description: r.description ?? "" })),
    };
  });

export interface SensitiveData {
  processes: MatrixProcess[];
  sensitive: string[];
}

export const loadSensitive = (): Promise<SensitiveData | null> =>
  asAdmin(async (tx, { registry }) => {
    const rows = await tx<{ process_id: string }[]>`select process_id from kernel.v_sensitive_processes where company_id = kernel.current_company_id()`;
    return { processes: matrixProcesses(registry, await usableModules(tx, registry)), sensitive: rows.map((r) => r.process_id) };
  });

export interface VerifiersData {
  providers: Record<string, string | null>;
  /** The providers with a registered adapter: the only ones kernel.verifier.set accepts. */
  available: string[];
}

export const loadVerifiers = (): Promise<VerifiersData | null> =>
  asAdmin(async (tx) => {
    const rows = await tx<{ kind: string; provider: string | null }[]>`select kind, provider from kernel.v_verifiers where company_id = kernel.current_company_id()`;
    return { providers: Object.fromEntries(rows.map((r) => [r.kind, r.provider])), available: registeredVerifiers() };
  });

export interface ModulesData {
  modules: (ModuleState & { usedBy: string[]; menu: string[] })[];
}

export const loadModules = (): Promise<ModulesData | null> =>
  asAdmin(async (tx, { registry }) => {
    const states = (await moduleStates(tx, registry)).filter((m) => m.id !== "kernel");
    return {
      modules: states.map((state) => {
        const def = registry.module(state.id);
        const items = [...def.navigation, ...def.features.flatMap((f) => f.nav ?? [])].filter((item) => item.menu !== false);
        return {
          ...state,
          usedBy: states.filter((other) => other.dependsOn.includes(state.id)).map((other) => other.id),
          menu: [...new Set(items.map((item) => item.label))],
        };
      }),
    };
  });

export interface CompanyData {
  legalName: string;
  tradeName: string | null;
  taxId: string | null;
  countryCode: string;
  currencyCode: string;
  timezone: string;
}

export const loadCompany = (): Promise<CompanyData | null> =>
  asAdmin(async (tx) => {
    const [row] = await tx<{ legal_name: string; trade_name: string | null; tax_id: string | null; country_code: string; currency_code: string; timezone: string }[]>`
      select legal_name, trade_name, tax_id, country_code, currency_code, timezone from kernel.v_companies`;
    return {
      legalName: row!.legal_name,
      tradeName: row!.trade_name,
      taxId: row!.tax_id,
      countryCode: row!.country_code,
      currencyCode: row!.currency_code,
      timezone: row!.timezone,
    };
  });

export const loadAiUsage = (month?: string): Promise<AiUsage | null> => asAdmin((tx, { caller }) => readAiUsage(tx, caller.claims.active_company_id, month));
