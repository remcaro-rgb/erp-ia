import "server-only";
import {
  DOC_TEMPLATE_ENTITY,
  defaultTemplate,
  printableFields,
  printLabels,
  translatorFor,
  variableNames,
  type Block,
  type Registry,
  type ResolvedEntityDef,
  type TemplateScope,
  type Tx,
} from "@erp/kernel";
import { asAdmin, members, roles, usableModules, type AdminMember, type AdminRole } from "@/lib/admin/load";

// What the Parámetros screens of the entity types show (Task 16; entity types spec §5.4, §6, §7, §9.2; approved prototype): plain reads as
// the caller under company RLS, company admin only (null for anyone else: the screen says they may not administer). Every change goes
// through the kernel.* settings processes (./actions, step-up, audited).

/** The screens a module's Parámetros lists (KERNEL_PARAMETER_PAGES' paths). */
export const PARAMETER_PAGES = ["tipos", "destinatarios", "plantillas"] as const;
export type ParameterPage = (typeof PARAMETER_PAGES)[number];

export interface TypedEntityInfo {
  id: string;
  /** i18n key of the entity's name. */
  label: string;
  type: "maestro" | "documento";
  /** i18n keys of the notes shown instead of a switch when the entity sets the flag itself (`typed.ownFlags`). */
  ownRequiresApproval: string | null;
  ownPosts: string | null;
}

const typedEntitiesOf = (registry: Registry, moduleId: string): ResolvedEntityDef[] =>
  registry.entities().filter((e) => e.module === moduleId && e.kind !== "query" && (e.entityType === "maestro" || e.entityType === "documento"));

const infoOf = (e: ResolvedEntityDef): TypedEntityInfo => ({
  id: e.id,
  label: e.label,
  type: e.entityType as "maestro" | "documento",
  ownRequiresApproval: e.typed?.ownFlags?.requiresApproval ?? null,
  ownPosts: e.typed?.ownFlags?.posts ?? null,
});

/** The module's typed entities when the company uses it, else null (the page is not found). */
async function moduleEntities(tx: Tx, registry: Registry, moduleId: string): Promise<ResolvedEntityDef[] | null> {
  if (!(await usableModules(tx, registry)).has(moduleId)) return null;
  const entities = typedEntitiesOf(registry, moduleId);
  return entities.length > 0 ? entities : null;
}

/** A screen of the module: `null` when the caller is not the admin, `{ missing: true }` when the module has no such screen here. */
export type Loaded<T> = T | { missing: true } | null;

export interface TiposData {
  moduleId: string;
  entities: (TypedEntityInfo & { requiresApproval: boolean; posts: boolean })[];
}

export const loadTipos = (moduleId: string): Promise<Loaded<TiposData>> =>
  asAdmin(async (tx, { registry }) => {
    const entities = await moduleEntities(tx, registry, moduleId);
    if (!entities) return { missing: true } as const;
    const rows = await tx<{ entity: string; requires_approval: boolean; posts: boolean }[]>`
      select entity, requires_approval, posts from kernel.entity_type_settings where company_id = kernel.current_company_id()`;
    const byEntity = new Map(rows.map((r) => [r.entity, r]));
    return {
      moduleId,
      entities: entities.map((e) => ({ ...infoOf(e), requiresApproval: byEntity.get(e.id)?.requires_approval === true, posts: e.entityType === "documento" && byEntity.get(e.id)?.posts === true })),
    };
  });

export interface DestinatariosData {
  moduleId: string;
  entities: TypedEntityInfo[];
  /** The e-mails by entity and status. */
  lists: Record<string, Record<string, string[]>>;
}

export const loadDestinatarios = (moduleId: string): Promise<Loaded<DestinatariosData>> =>
  asAdmin(async (tx, { registry }) => {
    const entities = await moduleEntities(tx, registry, moduleId);
    if (!entities) return { missing: true } as const;
    const rows = await tx<{ entity: string; status: string; emails: string[] }[]>`
      select entity, status, emails from kernel.state_recipients where company_id = kernel.current_company_id()`;
    const lists: Record<string, Record<string, string[]>> = {};
    for (const row of rows) (lists[row.entity] ??= {})[row.status] = row.emails;
    return { moduleId, entities: entities.map(infoOf), lists };
  });

/** A field a block may name, or a column of a table block. */
export interface TemplateField {
  name: string;
  /** i18n key of its label. */
  label: string;
  money: boolean;
}

export interface TemplateEntity extends TypedEntityInfo {
  /** The record's printable fields (field blocks, list columns). */
  fields: TemplateField[];
  /** The columns of its lines (record scope), or null without lines. */
  lineColumns: TemplateField[] | null;
  /** The variables each scope may print. */
  variables: Record<TemplateScope, string[]>;
  /** The built-in template's blocks per scope: where a new template starts. */
  defaults: Record<TemplateScope, Block[]>;
}

export interface TemplateRow {
  id: string;
  entity: string;
  scope: TemplateScope;
  name: string;
  version: number;
  isDefault: boolean;
  backgroundFileId: string | null;
  blocks: Block[];
  /** The files attached to the template (background PDFs, logos). */
  files: { id: string; fileName: string; mimeType: string }[];
}

export interface PlantillasData {
  moduleId: string;
  entities: TemplateEntity[];
  templates: TemplateRow[];
  company: { name: string; taxId: string; address: string; city: string; phone: string; logoAttachmentId: string | null };
}

const fieldsOf = (entity: ResolvedEntityDef): TemplateField[] => printableFields(entity).map((f) => ({ name: f.name, label: f.label, money: f.type === "money" }));

export const loadPlantillas = (moduleId: string, locale: string): Promise<Loaded<PlantillasData>> =>
  asAdmin(async (tx, { registry }) => {
    const entities = await moduleEntities(tx, registry, moduleId);
    if (!entities) return { missing: true } as const;
    const t = translatorFor(locale);
    const info: TemplateEntity[] = entities.map((e) => {
      const lines = e.typed?.lines ? registry.entity(e.typed.lines.entity) : null;
      const title = t(e.label) ?? e.id;
      const blocksOf = (scope: TemplateScope) => defaultTemplate(e, scope, { labels: printLabels(lines && scope === "record" ? [e, lines] : [e], t), title }).blocks;
      return {
        ...infoOf(e),
        fields: fieldsOf(e),
        lineColumns: lines ? fieldsOf(lines).filter((f) => f.name !== e.typed!.lines!.parentField) : null,
        variables: { record: [...variableNames(e, "record")], list: [...variableNames(e, "list")] },
        defaults: { record: blocksOf("record"), list: blocksOf("list") },
      };
    });
    const ids = entities.map((e) => e.id);
    const rows = await tx<{ id: string; entity: string; scope: TemplateScope; name: string; version: number; is_default: boolean; background_file_id: string | null; blocks: Block[] }[]>`
      select id, entity, scope, name, version, is_default, background_file_id, blocks from kernel.v_doc_templates
      where company_id = kernel.current_company_id() and entity in ${tx(ids)} order by entity, scope, name`;
    const files = rows.length
      ? await tx<{ id: string; record_id: string; file_name: string; mime_type: string }[]>`
          select id, record_id, file_name, mime_type from kernel.attachments
          where company_id = kernel.current_company_id() and entity = ${DOC_TEMPLATE_ENTITY} and record_id in ${tx(rows.map((r) => r.id))} and removed_at is null
          order by created_at`
      : [];
    // The letterhead's own data (kernel.admin.company.update), as the templates print it.
    const [company] = await tx<{ legal_name: string; tax_id: string | null; address_line: string | null; city: string | null; phone_cc: string | null; phone: string | null; logo_attachment_id: string | null }[]>`
      select legal_name, tax_id, address_line, city, phone_cc, phone, logo_attachment_id from kernel.companies where id = kernel.current_company_id()`;
    return {
      moduleId,
      entities: info,
      templates: rows.map((r) => ({
        id: r.id,
        entity: r.entity,
        scope: r.scope,
        name: r.name,
        version: r.version,
        isDefault: r.is_default,
        backgroundFileId: r.background_file_id,
        blocks: r.blocks,
        files: files.filter((f) => f.record_id === r.id).map((f) => ({ id: f.id, fileName: f.file_name, mimeType: f.mime_type })),
      })),
      company: {
        name: company?.legal_name ?? "",
        taxId: company?.tax_id ?? "",
        address: company?.address_line ?? "",
        city: company?.city ?? "",
        phone: company?.phone ? `+${company.phone_cc ?? "57"} ${company.phone}` : "",
        logoAttachmentId: company?.logo_attachment_id ?? null,
      },
    };
  });

/** One item of a module's menu, for Acceso al menú: its key (never shown), its label (an i18n key) and its depth. */
export interface MenuNode {
  key: string;
  label: string;
  depth: number;
}

export interface MenuRule {
  roleId: string | null;
  userId: string | null;
  allowed: boolean;
}

export interface MenuAccessData {
  nodes: MenuNode[];
  rules: Record<string, MenuRule[]>;
  roles: AdminRole[];
  members: AdminMember[];
}

export const loadMenuAccess = (): Promise<MenuAccessData | null> =>
  asAdmin(async (tx, { registry }) => {
    const usable = await usableModules(tx, registry);
    const synced = new Set((await tx<{ nav_key: string }[]>`select nav_key from kernel.menu_items`).map((r) => r.nav_key));
    const nodes: MenuNode[] = [];
    // The modules the company uses, as their menus show them; the platform's own screens (Sistema) are the admin's and never narrowed.
    for (const mod of registry.modules()) {
      if (mod.id === "kernel" || !usable.has(mod.id) || mod.navigation.length === 0) continue;
      nodes.push({ key: `module:${mod.id}`, label: `nav.modules.${mod.id}`, depth: 0 });
      for (const item of mod.navigation) {
        if (!synced.has(item.id)) continue;
        nodes.push({ key: item.id, label: item.label, depth: 1 });
        for (const child of item.children ?? []) if (synced.has(child.id)) nodes.push({ key: child.id, label: child.label, depth: 2 });
      }
    }
    const rows = await tx<{ nav_key: string; grantee_role_id: string | null; grantee_user_id: string | null; allowed: boolean }[]>`
      select nav_key, grantee_role_id, grantee_user_id, allowed from kernel.menu_access where company_id = kernel.current_company_id() order by created_at, id`;
    const rules: Record<string, MenuRule[]> = {};
    for (const r of rows) (rules[r.nav_key] ??= []).push({ roleId: r.grantee_role_id, userId: r.grantee_user_id, allowed: r.allowed });
    return { nodes, rules, roles: (await roles(tx)).filter((r) => !r.isSystemAdmin), members: (await members(tx)).filter((m) => m.isActive) };
  });
