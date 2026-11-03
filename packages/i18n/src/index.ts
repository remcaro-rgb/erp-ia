import type { Registry } from "@erp/kernel";
import en from "../messages/en.json";
import es419 from "../messages/es-419.json";

// The catalogues of the application (rule 24): Spanish (Latam) is the source of truth, `en` mirrors its keys.
// Namespaces: common, nav, entity, field, feature, process, grid, home, agent, auth, errors. Keys are lowercase
// snake_case segments joined by dots; the registry's labels (`EntityDef.label`, `FieldDef.label`,
// `NavItem.label`, `FeatureDef.label`) are keys of `entity.*`, `field.*`, `nav.*` and `feature.*`;
// `ProcessError.code` is `errors.<code>`.

export const locales = ["es-419", "en"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "es-419";

/** A nested catalogue: leaves are ICU message strings. */
export interface Messages {
  [key: string]: string | Messages;
}

const catalogues: Record<Locale, Messages> = { "es-419": es419, en };

export const isLocale = (value: unknown): value is Locale => typeof value === "string" && (locales as readonly string[]).includes(value);

/** The whole catalogue of a locale. */
export const messages = (locale: Locale): Messages => catalogues[locale];

/**
 * The message at the dotted `key` in `locale` (the default locale for one the app does not offer), or undefined when it is not a
 * message. The servers register it as the kernel's catalogue (`registerCatalogue`), for what the kernel prints outside a screen.
 */
export function translate(locale: string, key: string): string | undefined {
  let node: string | Messages | undefined = catalogues[isLocale(locale) ? locale : defaultLocale];
  for (const part of key.split(".")) {
    if (typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * Every i18n key the loaded modules declare: entity labels, field labels, menu items (module-level and the
 * ones features unlock) and feature labels. Sorted, no duplicates. The catalogue test asserts each one exists.
 */
export function collectRegistryKeys(registry: Registry): string[] {
  const keys = new Set<string>();
  for (const entity of registry.entities()) {
    keys.add(entity.label);
    for (const field of entity.fields) keys.add(field.label);
  }
  for (const module of registry.modules()) {
    // Group children too: the menu sections hold most items (entity types spec §2.4).
    for (const item of module.navigation) for (const one of [item, ...(item.children ?? [])]) keys.add(one.label);
    for (const feature of module.features) {
      keys.add(feature.label);
      for (const item of feature.nav ?? []) keys.add(item.label);
    }
  }
  return [...keys].sort();
}
