import "server-only";
import { getTranslations } from "next-intl/server";
import {
  auditEntityOf,
  hasRecordPage,
  loadCustomFields,
  matrixProcesses,
  flattenNav,
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
import { loadGridPage, type GridPageData } from "@/lib/grid/load";
import type { AuditCatalogue } from "./audit-links";
import { callerIsCompanyAdmin } from "./company-admin";
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
  /** The admin exempted them from the admin role's second-step requirement (kernel.admin.user.mfa.set, design §22.19). */
  mfaExempt: boolean;
  /** The language the person uses the application in (`es-419`, `en`). */
  locale: string;
  /** False once the admin deactivated the membership (kernel.admin.user.update, design §22.16). */
  isActive: boolean;
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
    if (!(await callerIsCompanyAdmin(tx))) return null;
    return read(tx, { caller, registry: deps.registry });
  });
}

async function roles(tx: Tx): Promise<AdminRole[]> {
  const rows = await tx<{ id: string; name: string; description: string; party_scope: string; system_admin: boolean }[]>`
    select id, name, description, party_scope, is_system and name = 'admin' as system_admin
    from kernel.v_roles where company_id = kernel.current_company_id() order by is_system desc, created_at, id`;
  return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, partyScope: r.party_scope, isSystemAdmin: r.system_admin }));
}

type MemberRow = {
  user_id: string;
  full_name: string | null;
  email: string;
  mobile_cc: string | null;
  mobile: string | null;
  photo: string | null;
  role_ids: string[];
  mfa_enrolled: boolean | null;
  mfa_exempt: boolean;
  locale: string | null;
  is_active: boolean;
};

async function members(tx: Tx, userId?: string): Promise<AdminMember[]> {
  const rows = await tx<MemberRow[]>`select user_id, full_name, email, mobile_cc, mobile, photo, role_ids, mfa_enrolled, mfa_exempt, locale, is_active
    from kernel.v_memberships where company_id = kernel.current_company_id() and (${userId ?? null}::uuid is null or user_id = ${userId ?? null}::uuid)
    order by full_name, email`;
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.full_name ?? r.email,
    email: r.email,
    mobileCc: r.mobile_cc,
    mobile: r.mobile,
    photo: r.photo,
    roleIds: r.role_ids,
    mfaEnrolled: r.mfa_enrolled === true,
    mfaExempt: r.mfa_exempt === true,
    locale: r.locale ?? "es-419",
    isActive: r.is_active,
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

/** A user's page (design §22.16): the member, the company's roles (to name theirs and edit them) and their last activity. */
export interface UserPageData {
  member: AdminMember;
  roles: AdminRole[];
  /** When the newest audit entry of theirs in the company happened (ISO), or null. */
  lastActivity: string | null;
  /** The page is the caller's own: they cannot deactivate themselves. */
  self: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The page of a member of the active company: null for anyone but its admin, `{ member: null }` for a non-member. */
export const loadUser = (userId: string): Promise<UserPageData | { member: null } | null> =>
  asAdmin(async (tx, { caller }) => {
    if (!UUID.test(userId)) return { member: null };
    const [member] = await members(tx, userId);
    if (!member) return { member: null };
    const [last] = await tx<{ occurred_at: Date }[]>`
      select occurred_at from kernel.v_audit_entries
      where company_id = kernel.current_company_id() and actor_user_id = ${userId} order by occurred_at desc limit 1`;
    return { member, roles: await roles(tx), lastActivity: last ? last.occurred_at.toISOString() : null, self: userId === caller.claims.sub };
  });

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
        const items = flattenNav([...def.navigation, ...def.features.flatMap((f) => f.nav ?? [])]).filter((item) => item.menu !== false);
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

export interface AuditPageData extends GridPageData {
  catalogue: AuditCatalogue;
}

/** The names of the processes, entities and members the audit grid shows instead of their ids (design §22.14). */
function auditCatalogue(registry: Registry, t: (key: string) => string, people: AdminMember[]): AuditCatalogue {
  const entities: AuditCatalogue["entities"] = {};
  for (const entity of registry.entities()) {
    // The entity id, its table (row changes), the prefixes of its processes (`core.category.*`, `core.contact.*`).
    const short = entity.id.slice(entity.id.indexOf(".") + 1).split("_").at(-1);
    const prefixes = Object.values(entity.processIds ?? {}).map((p) => p.slice(0, p.lastIndexOf(".")));
    const spellings = [entity.id, `${entity.schema}.${entity.table}`, ...prefixes, `${entity.module}.${short}`];
    // Only the spellings that name this entity and no other (auditEntityOf is the rule the detail follows too).
    for (const spelling of new Set(spellings)) if (auditEntityOf(registry, spelling)?.id === entity.id) entities[spelling] = { id: entity.id, label: t(entity.label), recordPage: hasRecordPage(entity) };
  }
  return {
    processes: Object.fromEntries(registry.processes().map((p) => [p.id, p.description])),
    entities,
    members: Object.fromEntries(people.map((m) => [m.userId, m.name])),
  };
}

/**
 * Auditoría (design §5.9, §6, §22.14): the company's audit log as a grid of the registry entity `kernel.audit`, read over
 * `kernel.v_audit_entries`, with the names its cells show (process descriptions, entity names, members). Opens for a
 * caller whose roles may run `kernel.audit.consult` and who administers the company (the view shows nothing to anyone
 * else); null otherwise. The grid's own requests, filters and exports go through the same gate (POST
 * /api/grid/kernel.audit, kernel.export.run); an entry's detail through kernel.audit.entry.
 */
export async function loadAudit(): Promise<AuditPageData | null> {
  const people = await asAdmin((tx) => members(tx));
  if (!people) return null;
  const [result, t] = await Promise.all([loadGridPage("kernel.audit", "/admin/audit"), getTranslations()]);
  if (!result.ok) return null;
  return { ...result.data, catalogue: auditCatalogue(processDeps().registry, (key) => t(key), people) };
}
