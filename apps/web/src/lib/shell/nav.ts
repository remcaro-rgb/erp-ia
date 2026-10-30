import { flattenNav, type NavItem, type Registry } from "@erp/kernel";
import type { ShellModule } from "@erp/ui";

// What the application shell offers the caller, from the registry (design §19a, rules 4 and 13). Pure: the
// entitlements and the runnable processes are resolved by the caller of `buildShellNav` (lib/shell/load.ts).

export interface ShellAccess {
  /** Entitlement keys (`module:x`, `feature:x.y`) the active company holds. */
  entitled: ReadonlySet<string>;
  /** Process ids one of the caller's roles may run in the active company. */
  runnable: ReadonlySet<string>;
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

/** The kernel is the platform (Sistema: administration, AI usage): always entitled, listed after the modules. */
const PLATFORM = "kernel";

/** The registry's modules with the platform last: the first module of the shell carries Inicio. */
const shellModules = (registry: Registry) => [...registry.modules().filter((m) => m.id !== PLATFORM), ...registry.modules().filter((m) => m.id === PLATFORM)];

/** Every menu item of a module: its navigation plus the ones its features unlock, once each, in manifest order. */
function moduleItems(mod: ReturnType<Registry["modules"]>[number]): NavItem[] {
  const items = new Map<string, NavItem>();
  for (const item of [...mod.navigation, ...mod.features.flatMap((f) => f.nav ?? [])]) if (!items.has(item.id)) items.set(item.id, item);
  return [...items.values()];
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
 * The modules (entitled, with at least one item for the caller; the platform's Sistema last and always entitled), their menu items (feature entitled and one of
 * the feature's processes runnable by the caller; an item naming a `process` also needs that one runnable) and the create commands (`<module>.<noun>.create` runnable,
 * on the item of its feature whose id starts with the noun's stem: `core.party.create` → `core.parties`).
 */
export function buildShellNav(registry: Registry, access: ShellAccess): ShellNav {
  const modules: ShellModule[] = [];
  const nav: NavItem[] = [];
  const creates: ShellCreate[] = [];
  for (const mod of shellModules(registry)) {
    if (mod.id !== PLATFORM && !access.entitled.has(`module:${mod.id}`)) continue;
    const opens = (item: NavItem) => {
      if (item.process && !access.runnable.has(item.process)) return false;
      if (!item.feature) return true;
      const feature = mod.features.find((f) => f.id === item.feature);
      return access.entitled.has(`feature:${item.feature}`) && (feature?.processes.some((p) => access.runnable.has(p)) ?? false);
    };
    // A group keeps the children the caller may open and is dropped when none is left.
    const visibleItems = moduleItems(mod).flatMap((item): NavItem[] => {
      if (!item.children) return opens(item) ? [item] : [];
      const children = opens(item) ? item.children.filter(opens) : [];
      return children.length > 0 ? [{ ...item, children }] : [];
    });
    if (visibleItems.length === 0) continue;
    modules.push({ id: mod.id, label: `nav.modules.${mod.id}` });
    nav.push(...visibleItems);
    const visible = flattenNav(visibleItems);
    for (const item of visible) {
      const feature = mod.features.find((f) => f.id === item.feature);
      for (const processId of feature?.processes ?? []) {
        const process = registry.process(processId);
        if (process.kind !== "create" || !access.runnable.has(processId) || creates.some((c) => c.processId === processId)) continue;
        const stem = processId.slice(0, processId.lastIndexOf("."));
        const noun = stem.slice(stem.indexOf(".") + 1);
        const target = visible.find((v) => v.feature === item.feature && v.id.startsWith(`${mod.id}.${noun.slice(0, -1)}`));
        if (target) creates.push({ processId, labelKey: `nav.create.${stem}`, href: `${target.href}?new=1` });
      }
    }
  }
  return { modules, nav, creates };
}
