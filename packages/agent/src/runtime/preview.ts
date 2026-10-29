import { defaultLocale, isLocale, messages, type Messages } from "@erp/i18n";
import { countryPackOf, fieldOfKey, valueText, type ProcessDef, type Registry, type ValueLabels } from "@erp/kernel";

// What a confirmation card shows (design §6 "Agent": "card with the diff"): the process's description as its title,
// one line per input field with the field's label in the user's language, the permission it runs under and whether
// the user will be asked for a step-up code. Values read as the forms and grids show them: an enum by its catalogue
// label (`FieldDef.valuesKey`), a fiscal code by the country pack's (`FieldDef.codes`: "31 · NIT", "Medellín"), money as
// `$ 1.234.567,00`, never the stored code alone: the kernel's shared label helper, which the audit viewer uses too.

export interface ConfirmationPreview {
  title: string;
  effects: { label: string; value: string }[];
  /** The process the confirmation runs, which the user's role must allow. */
  permission: string;
  /** True when the run needs a fresh step-up code (the process or the company marks it sensitive). */
  stepUp: boolean;
}

/** The catalogue entry at a dotted key, when it is a message. */
export function message(catalogue: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = catalogue;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

export const catalogueOf = (locale: string): Messages => messages(isLocale(locale) ? locale : defaultLocale);

/** `core.party.create` acts on the registered entity `core.party`, when there is one. */
function entityOf(registry: Registry, def: ProcessDef) {
  const id = def.id.slice(0, def.id.lastIndexOf("."));
  return registry.entities().find((e) => e.id === id);
}

/** The card of a proposed run of `def` with `input` (already validated by the process's schema); `country` is the company's (its pack labels the fiscal codes). */
export function buildPreview(registry: Registry, def: ProcessDef, input: unknown, options: { locale: string; stepUp: boolean; country?: string }): ConfirmationPreview {
  const catalogue = catalogueOf(options.locale);
  // The label helper the audit viewer shares (kernel registry/labels.ts): option labels, the pack's codes, money, Sí / No.
  const labels: ValueLabels = { t: (key) => message(catalogue, key), locale: options.locale, pack: countryPackOf(options.country) };
  const entity = entityOf(registry, def);
  const fieldOf = (key: string) => (entity ? fieldOfKey(entity.fields, key) : undefined);
  const label = (key: string): string => {
    const field = fieldOf(key);
    return (field && message(catalogue, field.label)) ?? key;
  };
  const entries = input !== null && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : [["input", input] as const];
  const effects = entries
    .filter(([, value]) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => ({ label: label(key), value: valueText(fieldOf(key), value, labels) }));
  return { title: def.description, effects, permission: def.id, stepUp: options.stepUp };
}
