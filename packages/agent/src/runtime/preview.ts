import { defaultLocale, isLocale, messages, type Messages } from "@erp/i18n";
import type { ProcessDef, Registry } from "@erp/kernel";

// What a confirmation card shows (design §6 "Agent": "card with the diff"): the process's description as its title,
// one line per input field with the field's label in the user's language, the permission it runs under and whether
// the user will be asked for a step-up code.

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

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** `core.party.create` acts on the registered entity `core.party`, when there is one. */
function entityOf(registry: Registry, def: ProcessDef) {
  const id = def.id.slice(0, def.id.lastIndexOf("."));
  return registry.entities().find((e) => e.id === id);
}

function render(value: unknown, catalogue: Messages): string {
  if (typeof value === "boolean") return message(catalogue, value ? "common.yes" : "common.no") ?? String(value);
  if (Array.isArray(value)) return value.map((v) => render(v, catalogue)).join(", ");
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** The card of a proposed run of `def` with `input` (already validated by the process's schema). */
export function buildPreview(registry: Registry, def: ProcessDef, input: unknown, options: { locale: string; stepUp: boolean }): ConfirmationPreview {
  const catalogue = catalogueOf(options.locale);
  const entity = entityOf(registry, def);
  const label = (key: string): string => {
    const field = entity?.fields.find((f) => f.name === snake(key) || f.name === key);
    return (field && message(catalogue, field.label)) ?? key;
  };
  const entries = input !== null && typeof input === "object" && !Array.isArray(input) ? Object.entries(input) : [["input", input] as const];
  const effects = entries
    .filter(([, value]) => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => ({ label: label(key), value: render(value, catalogue) }));
  return { title: def.description, effects, permission: def.id, stepUp: options.stepUp };
}
