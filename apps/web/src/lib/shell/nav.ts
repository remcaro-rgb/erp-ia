import { flattenNav, type NavItem, type Registry } from "@erp/kernel";
import type { ShellModule } from "@erp/ui";

// What the application shell offers the caller, from the registry (design §19a, rules 4 and 13). Pure: the
// entitlements and the runnable processes are resolved by the caller of `buildShellNav` (lib/shell/load.ts).

export interface ShellAccess {
  /** Entitlement keys (`module:x`, `feature:x.y`) the active company holds. */
  entitled: ReadonlySet<string>;
  /** Process ids one of the caller's roles may run in the active company. */
  runnable: ReadonlySet<string>;
  /**
   * Menu items the company's rules hide for the caller (kernel.menu_hidden_keys, entity types spec §9.2): dropped, a hidden section
   * with everything under it. Only narrows: an item still needs its entitlement and a runnable process. Empty for a company admin.
   */
  hidden?: ReadonlySet<string>;
}

/** A create process the ⌘K palette offers: its label key (`nav.create.<entity>`) and the screen it opens on. */
export interface ShellCreate {
  processId: string;
  labelKey: string;
  href: string;
}

export interface ShellNav {
  modules: ShellModule[];
  nav: NavItem[];
  creates: ShellCreate[];
}

/** The palette offers only `<module>.<noun>.create` (owner 2026-10-31, UX-OD-5): from a template, reversals and openings stay on their screens. */
const CREATE_NAME = /^[a-z_]+\.[a-z_]+\.create$/;

/** The kernel is the platform (Sistema: administration, AI usage): always entitled, listed after the modules. */
const PLATFORM = "kernel";

/** The registry's modules with the platform last: the first module of the shell carries Inicio. */
const shellModules = (registry: Registry) => [...registry.modules().filter((m) => m.id !== PLATFORM), ...registry.modules().filter((m) => m.id === PLATFORM)];

/** Every menu item of a module: its navigation plus the ones its features unlock, once each, in manifest order. */
function moduleItems(mod: ReturnType<Registry["modules"]>[number]): NavItem[] {
  // A feature lists its group children flat (`FeatureDef.nav`): those already sit under their group, so ids are compared across the whole tree.
  const seen = new Set(flattenNav(mod.navigation).map((i) => i.id));
  const items = [...mod.navigation];
  for (const item of mod.features.flatMap((f) => f.nav ?? [])) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return items;
}

/** The keys `buildShellNav` needs resolved: entitlements to check and processes to ask permission for. */
export function shellAccessKeys(registry: Registry): { entitlements: string[]; processes: string[] } {
  const entitlements = new Set<string>();
  const processes = new Set<string>();
  for (const mod of registry.modules()) {
    const items = moduleItems(mod).flatMap((item) => [item, ...(item.children ?? [])]);
    if (items.length === 0) continue;
    if (mod.id !== PLATFORM) entitlements.add(`module:${mod.id}`);
    for (const item of items) if (item.process) processes.add(item.process);
    for (const feature of mod.features) {
      if (!items.some((item) => item.feature === feature.id)) continue;
      entitlements.add(`feature:${feature.id}`);
      for (const id of feature.processes) processes.add(id);
    }
  }
  return { entitlements: [...entitlements], processes: [...processes] };
}

/**
 * The modules (entitled, with at least one screen the caller may open; the platform's Sistema last and always entitled), their menu items
 * (feature entitled and one of the feature's processes runnable by the caller; an item naming a `process` also needs that one runnable; an
 * item the company's menu rules hide for the caller never shows) and the create commands (`<module>.<noun>.create` runnable, on the item of
 * its feature whose id starts with the noun's stem: `core.party.create` → `core.parties`). A module's menu sections (Maestros, Documentos,
 * Reportes, Parámetros) stay even when empty, so the shell can say so (entity types spec §9.2); another group the caller has nothing in is
 * dropped.
 */
export function buildShellNav(registry: Registry, access: ShellAccess): ShellNav {
  const modules: ShellModule[] = [];
  const nav: NavItem[] = [];
  const creates: ShellCreate[] = [];
  const hidden = access.hidden ?? new Set<string>();
  for (const mod of shellModules(registry)) {
    if (mod.id !== PLATFORM && !access.entitled.has(`module:${mod.id}`)) continue;
    const opens = (item: NavItem) => {
      if (hidden.has(item.id)) return false;
      if (item.process && !access.runnable.has(item.process)) return false;
      if (!item.feature) return true;
      const feature = mod.features.find((f) => f.id === item.feature);
      return access.entitled.has(`feature:${item.feature}`) && (feature?.processes.some((p) => access.runnable.has(p)) ?? false);
    };
    // A group keeps the children the caller may open; a section stays when it has none left, any other group is dropped.
    const visibleItems = moduleItems(mod).flatMap((item): NavItem[] => {
      if (!item.children) return opens(item) ? [item] : [];
      if (hidden.has(item.id)) return [];
      const children = opens(item) ? item.children.filter(opens) : [];
      return children.length > 0 || item.section ? [{ ...item, children }] : [];
    });
    const visible = flattenNav(visibleItems);
    if (visible.length === 0) continue;
    modules.push({ id: mod.id, label: `nav.modules.${mod.id}`, ...(mod.icon ? { icon: mod.icon } : {}) });
    nav.push(...visibleItems);
    for (const item of visible) {
      const feature = mod.features.find((f) => f.id === item.feature);
      for (const processId of feature?.processes ?? []) {
        const process = registry.process(processId);
        if (process.kind !== "create" || !CREATE_NAME.test(processId) || !access.runnable.has(processId) || creates.some((c) => c.processId === processId)) continue;
        const stem = processId.slice(0, processId.lastIndexOf("."));
        const noun = stem.slice(stem.indexOf(".") + 1);
        const target = visible.find((v) => v.feature === item.feature && v.id.startsWith(`${mod.id}.${noun.slice(0, -1)}`));
        if (target) creates.push({ processId, labelKey: `nav.create.${stem}`, href: `${target.href}?new=1` });
      }
    }
  }
  return { modules, nav: adoptItems(registry, nav), creates };
}

/**
 * ModuleDef.adopts: an item the caller may open moves from its own module's section into the same section of the adopting module,
 * first in the list, when that module is in the shell. Otherwise it stays where its module put it.
 */
function adoptItems(registry: Registry, nav: NavItem[]): NavItem[] {
  let out = nav;
  for (const mod of registry.modules()) {
    for (const itemId of mod.adopts ?? []) {
      const from = out.find((g) => g.children?.some((c) => c.id === itemId));
      const item = from?.children?.find((c) => c.id === itemId);
      const to = from?.section ? out.find((g) => g.id === `${mod.id}.${from.section}`) : undefined;
      if (!from || !item || !to || to === from) continue;
      out = out.map((g) => (g === from ? { ...g, children: g.children!.filter((c) => c.id !== itemId) } : g === to ? { ...g, children: [item, ...g.children!] } : g));
    }
  }
  return out;
}
