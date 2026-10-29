import { cellText } from "../exports/format";
import type { ExportType } from "../exports/types";
import { countryPack, type CodeTable, type CountryPack } from "../localization/country-pack";
import type { FieldDef } from "./fields";

// How a stored value reads for a person (design §22.14, rule 23), in ONE place for every channel that shows values outside
// a grid: the audit viewer's before/after and the assistant's confirmation card. An enum by its catalogue label
// (`FieldDef.valuesKey`), a fiscal code by the country pack's (`FieldDef.codes`: "31 · NIT", "Medellín"), money as
// `$ 1.234.567,00`, dates and times in the company's zone, Sí / No; never the stored code alone. The kernel has no
// catalogue of its own: the caller passes its translator (`next-intl` on the web, the i18n catalogue in the agent).

/** A catalogue lookup: the message at `key`, or undefined when the catalogue has none. */
export type Translate = (key: string) => string | undefined;

export interface ValueLabels {
  t: Translate;
  /** `es-419` or `en`: the pack's names of places and codes. */
  locale: string;
  /** The company's country pack (codes read as they are without one). */
  pack?: Pick<CountryPack, "codeLabel"> | undefined;
  /** The company's IANA zone: a date and time reads as the wall clock there. */
  timeZone?: string | undefined;
}

/** What the text of a value depends on: the field's type and where its value labels come from. */
export type LabelledField = Partial<Pick<FieldDef, "valuesKey" | "codes">> & { type?: string | null };

const FORMATTED = new Set<string>(["money", "date", "datetime"]);

/** The text of `value` of `field` ("" for nothing: null, undefined or empty text). */
export function valueText(field: LabelledField | undefined, value: unknown, labels: ValueLabels): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return labels.t(value ? "common.yes" : "common.no") ?? String(value);
  if (Array.isArray(value)) return value.map((v) => valueText(field, v, labels)).filter((text) => text !== "").join(", ");
  if (typeof value === "object" && !(value instanceof Date)) return JSON.stringify(value);
  const type = field?.type ?? undefined;
  if (type && FORMATTED.has(type)) return cellText({ field: "", label: "", type: type as ExportType }, value, { paper: true, timeZone: labels.timeZone, locale: labels.locale });
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (field?.valuesKey) return labels.t(`${field.valuesKey}.${text}`) ?? text;
  if (field?.codes) return labels.pack?.codeLabel(field.codes as CodeTable, text, labels.locale) ?? text;
  return text;
}

const snake = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** The field of `fields` a key names: its column (`trade_name`) or a process input's camelCase key (`tradeName`). */
export function fieldOfKey<F extends { name: string }>(fields: readonly F[], key: string): F | undefined {
  return fields.find((f) => f.name === key) ?? fields.find((f) => f.name === snake(key));
}

/** The registered pack of `country`, or none (codes then read as they are). */
export function countryPackOf(country: string | null | undefined): CountryPack | undefined {
  if (!country) return undefined;
  try {
    return countryPack(country);
  } catch {
    return undefined;
  }
}
