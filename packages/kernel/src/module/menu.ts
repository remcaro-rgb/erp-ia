import type { EntityType } from "../registry/entities";
import type { MenuSection, ModuleDef, NavItem } from "../registry/types";

// Module menu sections (entity types spec 2026-11-02 §2.4, §9.2, design §22.23; Phase 2A.5 Task 10). Every module with a menu has the
// level-1 groups Maestros, Documentos, Reportes and Parámetros, named `<module>.maestros|documentos|reportes|parametros`. The list page of
// a maestro, documento or parametro (an item naming its `entity`) places itself in its section; an item may name its section itself
// (`section` on a leaf). A section may be empty: the shell shows its empty state. The kernel never names a module (rule 4): the sections
// come from each manifest, and the platform's own menu (Sistema, this kernel) is not a module menu.

/** The four sections, in the order the bar shows them. */
export const MENU_SECTIONS: readonly MenuSection[] = ["maestros", "documentos", "reportes", "parametros"];

/** The section the list page of an entity of this type sits in; lines and sistema entities have none. */
const SECTION_OF: Partial<Record<EntityType, MenuSection>> = { maestro: "maestros", documento: "documentos", parametro: "parametros" };

const SECTION_ICON: Record<MenuSection, string> = { maestros: "database", documentos: "file-text", reportes: "bar-chart", parametros: "sliders" };

/** The platform: its menu (Administración, Auditoría, Uso de IA) is Sistema, not a module menu. */
const PLATFORM = "kernel";

/** The four section groups of `moduleId`, each with the items given for it (labels `nav.section.<section>`, kernel copy). */
export function menuSections(moduleId: string, children: Partial<Record<MenuSection, NavItem[]>> = {}): NavItem[] {
  return MENU_SECTIONS.map((section) => ({
    id: `${moduleId}.${section}`,
    label: `nav.section.${section}`,
    href: "#",
    icon: SECTION_ICON[section],
    section,
    children: [...(children[section] ?? [])],
  }));
}

/**
 * A screen the kernel adds to the Parámetros section of every module with a maestro or documento, for that module's typed entities
 * (entity type settings, PDF templates, state recipients, menu access). Its address is `/<module>/parametros/<path>`; it shows to
 * whoever may run `process`.
 */
export interface ParameterPage {
  /** Item id suffix: the item is `<module>.<name>`. */
  name: string;
  /** i18n key. */
  label: string;
  icon: string;
  process: string;
  path: string;
}

/**
 * The kernel's Parámetros screens (Task 16, `apps/web/src/app/(app)/[module]/parametros/[page]`): each module with a maestro or documento
 * lists them for its own typed entities. They show to whoever may run their process: the company admin (the processes are kernel.admin
 * settings, step-up). Menu access is the platform's (Administración › Acceso al menú), not a module's.
 */
export const KERNEL_PARAMETER_PAGES: readonly ParameterPage[] = [
  { name: "entity_types", label: "nav.section.page.entity_types", icon: "list", process: "kernel.entity_type_settings.update", path: "tipos" },
  { name: "state_recipients", label: "nav.section.page.state_recipients", icon: "mail", process: "kernel.state_recipients.update", path: "destinatarios" },
  { name: "doc_templates", label: "nav.section.page.doc_templates", icon: "file", process: "kernel.doc_template.save", path: "plantillas" },
];

const isGroup = (item: NavItem) => item.children !== undefined;

/**
 * The module with its menu in sections (see the file comment). Throws `module x: missing menu section <s>` when a section group is
 * absent, `module x: menu section <s> must be the group x.<s>` when it is misnamed or is not a group, and refuses an item naming an
 * entity the module does not declare or listing a typed entity under another section than its type's. A module without any menu item
 * (a back-end module) and the platform carry no sections. Moves every top-level leaf that names a section, or the entity of a maestro,
 * documento or parametro, to the end of that section, in manifest order, and appends `pages` to Parámetros when the module has a
 * maestro or documento.
 */
export function withMenuSections(module: ModuleDef, pages: readonly ParameterPage[] = KERNEL_PARAMETER_PAGES): ModuleDef {
  const hasMenu = module.navigation.length > 0 || module.features.some((f) => (f.nav ?? []).length > 0);
  if (module.id === PLATFORM || !hasMenu) return module;

  const types = new Map(module.entities.map((e) => [e.id, e.kind === "query" ? undefined : e.entityType]));
  const sectionOf = (item: NavItem): MenuSection | undefined => {
    if (item.entity === undefined) return undefined;
    if (!types.has(item.entity)) throw new Error(`module ${module.id}: menu item ${item.id} names entity ${item.entity}, which the module does not declare`);
    const type = types.get(item.entity);
    return type ? SECTION_OF[type] : undefined;
  };

  for (const item of module.navigation) {
    if (!item.section || !isGroup(item)) continue;
    if (item.id !== `${module.id}.${item.section}`) throw new Error(`module ${module.id}: menu section ${item.section} must be the group ${module.id}.${item.section}`);
  }
  const groups = new Map<MenuSection, NavItem>();
  for (const section of MENU_SECTIONS) {
    const id = `${module.id}.${section}`;
    const declared = module.navigation.find((i) => i.section === section || i.id === id);
    if (!declared) throw new Error(`module ${module.id}: missing menu section ${section}`);
    if (declared.id !== id || declared.section !== section || !isGroup(declared)) throw new Error(`module ${module.id}: menu section ${section} must be the group ${id}`);
    groups.set(section, { ...declared, children: [...declared.children!] });
  }

  // A typed entity's list page declared inside a section sits in its type's section.
  for (const [section, group] of groups) {
    for (const child of group.children!) {
      const own = sectionOf(child);
      if (own && own !== section) throw new Error(`module ${module.id}: menu item ${child.id} lists ${child.entity} (${types.get(child.entity!)}) under ${section}, not ${own}`);
    }
  }

  const rest: NavItem[] = [];
  for (const item of module.navigation) {
    if (item.section && isGroup(item)) continue;
    // Validates the entity of every item, groups' children included.
    for (const child of item.children ?? []) sectionOf(child);
    const target = isGroup(item) ? undefined : (item.section ?? sectionOf(item));
    if (target) {
      // The item now sits in its section: a leaf carries no `section` of its own.
      const leaf = { ...item };
      delete leaf.section;
      groups.get(target)!.children!.push(leaf);
    } else rest.push(item);
  }

  const typed = module.entities.some((e) => e.kind !== "query" && (e.entityType === "maestro" || e.entityType === "documento"));
  if (typed) {
    for (const page of pages) {
      groups.get("parametros")!.children!.push({ id: `${module.id}.${page.name}`, label: page.label, href: `/${module.id}/parametros/${page.path}`, icon: page.icon, process: page.process });
    }
  }
  return { ...module, navigation: [...MENU_SECTIONS.map((s) => groups.get(s)!), ...rest] };
}

/** One menu item as `kernel.menu_items` stores it (synced by syncModuleManifest): what kernel.menu_access may hide and what that refuses. */
export interface MenuItemRow {
  navKey: string;
  moduleId: string;
  /** The group the item sits in (its section), or null for a level-1 item. */
  parentKey: string | null;
  /** The screen's address; null for a group. */
  href: string | null;
  /** The entity whose list page the item is: its record pages `/r/<entity>/…` are the item's too. */
  entity: string | null;
  /**
   * The processes refused while the item is hidden for the caller, sorted: its `process`, its entity's processes (`<entity>.<verb>`, its
   * declared create and attach processes) and its lines' (`typed.lines`), and its `runs`. A group lists none: hiding it hides its children.
   */
  processIds: string[];
}

/** Whether `id` is one of `patterns`: an id, or a prefix ending in ".". */
const matchesAny = (id: string, patterns: readonly string[]) => patterns.some((p) => (p.endsWith(".") ? id.startsWith(p) : id === p));

/**
 * Every item of the module's menu (as the registry holds it, sections placed), each group followed by its children. An item guards, of
 * its own module's processes only: its `process`, its entity's (`<entity>.<verb>`, the entity's declared processes and every process
 * whose `recordAccess.entity` is the entity), the same for its lines' entity, and its `runs`. A process of another module (the kernel's
 * import behind «Importar datos») is shared: hiding the item hides its page, and that process is refused by its target's item instead.
 */
export function menuItemsOf(module: ModuleDef): MenuItemRow[] {
  const own = module.processes;
  const boundTo = (entityId: string) =>
    own.filter((p) => p.id.startsWith(`${entityId}.`) || (typeof p.recordAccess === "object" && p.recordAccess.entity === entityId)).map((p) => p.id);
  const guarded = (item: NavItem): string[] => {
    const ids = new Set<string>();
    if (item.process && own.some((p) => p.id === item.process)) ids.add(item.process);
    const entity = item.entity ? module.entities.find((e) => e.id === item.entity) : undefined;
    if (entity) {
      for (const id of boundTo(entity.id)) ids.add(id);
      if (entity.typed?.lines) for (const id of boundTo(entity.typed.lines.entity)) ids.add(id);
      for (const id of Object.values(entity.processIds ?? {})) if (id && own.some((p) => p.id === id)) ids.add(id);
    }
    for (const p of own) if (matchesAny(p.id, item.runs ?? [])) ids.add(p.id);
    return [...ids].sort();
  };
  const row = (item: NavItem, parentKey: string | null): MenuItemRow => ({
    navKey: item.id,
    moduleId: module.id,
    parentKey,
    href: item.href === "#" ? null : item.href,
    entity: item.entity ?? null,
    processIds: isGroup(item) ? [] : guarded(item),
  });
  // A feature's item that is not in the navigation (an older manifest shape) is listed once, at the top level.
  const seen = new Set(module.navigation.flatMap((i) => [i.id, ...(i.children ?? []).map((c) => c.id)]));
  const extra = module.features.flatMap((f) => f.nav ?? []).filter((i) => !seen.has(i.id) && (seen.add(i.id), true));
  return [...module.navigation, ...extra].flatMap((item) => [row(item, null), ...(item.children ?? []).map((child) => row(child, item.id))]);
}

/**
 * The module's processes that no menu item guards and `menuShared` does not declare, in registration order (entity types spec §9.2:
 * a hidden item's processes are refused). Empty for a module without a menu. Each module's test asserts it is empty, so a process a
 * screen runs cannot be left reachable while the screen's item is hidden.
 */
export function uncoveredMenuProcesses(module: ModuleDef): string[] {
  const hasMenu = module.navigation.length > 0 || module.features.some((f) => (f.nav ?? []).length > 0);
  if (!hasMenu) return [];
  const covered = new Set(menuItemsOf(module).flatMap((r) => r.processIds));
  return module.processes.map((p) => p.id).filter((id) => !covered.has(id) && !matchesAny(id, module.menuShared ?? []));
}
