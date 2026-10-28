import type { Registry } from "@erp/kernel";
import en from "../messages/en.json";
import es419 from "../messages/es-419.json";

// The catalogues of the application (rule 24): Spanish (Latam) is the source of truth, `en` mirrors its keys.
// Namespaces: common, nav, entity, field, feature, process, grid, agent, auth, errors. Keys are lowercase
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
    for (const item of module.navigation) keys.add(item.label);
    for (const feature of module.features) {
      keys.add(feature.label);
      for (const item of feature.nav ?? []) keys.add(item.label);
    }
  }
  return [...keys].sort();
}
