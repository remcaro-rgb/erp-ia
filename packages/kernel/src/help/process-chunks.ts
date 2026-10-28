import type { Registry } from "../registry";
import type { ModuleDef, NavItem, ProcessDef } from "../registry/types";

// One help chunk per registered process (design §7): what the assistant can say about an action, and where in the
// app to do it.

export interface ProcessChunk {
  source: string;
  title: string;
  body: string;
  href?: string;
}

/** Names of the fields of a process's input, when its schema is an object. */
function fieldNames(process: ProcessDef): string[] {
  const schema = process.input as { shape?: Record<string, unknown>; def?: { in?: { shape?: Record<string, unknown> } } };
  return Object.keys(schema.shape ?? schema.def?.in?.shape ?? {});
}

/** Every menu item of a module: its navigation plus the ones its features unlock, once each (as the shell lists them). */
function moduleItems(module: ModuleDef): NavItem[] {
  const items = new Map<string, NavItem>();
  for (const item of [...module.navigation, ...module.features.flatMap((f) => f.nav ?? [])]) if (!items.has(item.id)) items.set(item.id, item);
  return [...items.values()];
}

/**
 * The screen a process is done on, from the navigation: the item (of any module) that names the process; else, in the
 * process's module, the item of the process's feature whose id starts with the noun's stem (`core.party.create` →
 * `core.parties`, the shell's rule for its ⌘K create commands), else the feature's first item. A `create` process
 * lands with `?new=1` (the screen opens a new record) when the item was matched by the noun. A process with no
 * screen has no link.
 */
export function processHref(registry: Registry, process: ProcessDef): string | undefined {
  // A menu item may name the process although another module owns it (core's "Importar datos" names kernel.import.run).
  const named = registry.modules().flatMap(moduleItems).find((item) => item.process === process.id);
  if (named) return named.href;
  if (!registry.hasModule(process.module)) return undefined;
  const module = registry.module(process.module);
  const items = moduleItems(module);
  const ofFeature = items.filter((item) => process.feature !== undefined && item.feature === process.feature);
  const noun = process.id.split(".")[1] ?? "";
  const matched = ofFeature.find((item) => item.id.startsWith(`${module.id}.${noun.slice(0, -1)}`));
  if (matched) return process.kind === "create" ? `${matched.href}?new=1` : matched.href;
  return ofFeature[0]?.href;
}

/** One chunk per registered process: its description and the names of its input fields. */
export function processChunks(registry: Registry): ProcessChunk[] {
  return registry.processes().map((process) => {
    const fields = fieldNames(process);
    return {
      source: `process:${process.id}`,
      title: process.description,
      body: fields.length > 0 ? `${process.description}\nCampos: ${fields.join(", ")}` : process.description,
      href: processHref(registry, process),
    };
  });
}
