import { PathError, interpolate, resolvePath } from "./path";
import { RuleTemplate, type RuleCondition, type RuleLine } from "./template";

export interface EventRef { id: string; event: string; payload: unknown; createdAt: Date; chainId: string }
export interface ComposedLine {
  role?: string; accountCode?: string; dimension?: string;
  /** The dimensions tried after `dimension`, in order, before the role alone (a rule line with a dimension list, Task 34.8b). */
  dimensionFallbacks?: string[];
  side: "debit" | "credit"; amountDoc: number; amountCompany: number;
  partyId?: string; costCenterId?: string; openAuxiliaryId?: string; itemId?: string; businessUnitId?: string;
  description?: string; taxCode?: string; taxRate?: number; taxBase?: number; reference?: string; dueDate?: string;
}
export interface ComposedEntry {
  date: string; description: string; currency: string; exchangeRate: number;
  partyId?: string; costCenterId?: string; openAuxiliaryId?: string; itemId?: string; businessUnitId?: string;
  source?: { entity: string; id: string }; lines: ComposedLine[]; roundingLine?: ComposedLine; sourceEventId: string; chainId: string;
}
export type ComposeResult = { ok: true; entry: ComposedEntry } | { ok: false; code: "invalid_template" | "unbalanced"; detail: string };

class Invalid extends Error {}

/** Half-up to two decimals, symmetric around zero (design §10a.8). */
const round2 = (n: number): number => {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Number(`${Math.abs(n)}e2`))) / 100 || 0;
};
const cents = (n: number): number => Math.round(n * 100);

const text = (v: unknown): string | undefined => (v === undefined || v === null || v === "" ? undefined : String(v));
const numberOf = (v: unknown, what: string): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new Invalid(`${what} does not resolve to a number`);
  return n;
};

const same = (a: unknown, b: unknown): boolean => (typeof a === "object" || typeof b === "object" ? JSON.stringify(a) === JSON.stringify(b) : Object.is(a, b));

/** Whether the template's `when` conditions all hold on `payload` (no `when`: always). A rule that does not apply is skipped, not failed. */
export function ruleApplies(template: RuleTemplate, payload: unknown): boolean {
  const conditions = (template as { when?: RuleCondition[] }).when;
  if (!Array.isArray(conditions)) return true;
  return conditions.every((condition) => {
    // A rule is stored as jsonb and may predate the schema's checks: a malformed condition throws (the engine records it).
    if (typeof condition?.path !== "string" || !/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(condition.path)) throw new PathError("invalid_path", String(condition?.path));
    const value = resolvePath(payload, condition.path);
    if (condition.in !== undefined) return value !== undefined && condition.in.some((candidate) => same(value, candidate));
    if (condition.notEquals !== undefined) return !same(value, condition.notEquals);
    return value !== undefined && same(value, condition.equals);
  });
}

export function composeEntry(template: RuleTemplate, event: EventRef, options: { tolerance: number; companyCurrency: string }): ComposeResult {
  const parsed = RuleTemplate.safeParse(template);
  if (!parsed.success) return { ok: false, code: "invalid_template", detail: parsed.error.issues.map((i) => i.message).join("; ") };
  const t = parsed.data;
  if (t.reverseOf) return { ok: false, code: "invalid_template", detail: "a reversal rule is not composed" };
  try {
    return build(t, event, options);
  } catch (error) {
    if (error instanceof Invalid || error instanceof PathError) return { ok: false, code: "invalid_template", detail: error.message };
    throw error;
  }
}

function build(t: RuleTemplate, event: EventRef, options: { tolerance: number; companyCurrency: string }): ComposeResult {
  const payload = event.payload;
  const at = (path: string | undefined, item?: unknown): unknown => (path === undefined ? undefined : resolvePath(payload, path, item));
  const date = text(at(t.date)) ?? event.createdAt.toISOString().slice(0, 10);
  const currency = text(at(t.currency)) ?? options.companyCurrency;
  const exchangeRate = t.exchangeRate === undefined ? 1 : numberOf(at(t.exchangeRate), "exchangeRate");
  const header = {
    partyId: text(at(t.party)), costCenterId: text(at(t.costCenter)), openAuxiliaryId: text(at(t.openAuxiliary)),
    itemId: text(at(t.item)), businessUnitId: text(at(t.businessUnit)),
  };

  const lines: ComposedLine[] = [];
  const compose = (line: RuleLine, item?: unknown): void => {
    const amountDoc = numberOf(at(line.amount, item), `amount of ${line.role ?? line.account}`);
    const raw = line.amountCompany === undefined ? amountDoc * exchangeRate : numberOf(at(line.amountCompany, item), "amountCompany");
    const amountCompany = round2(Math.abs(raw));
    if (amountCompany === 0) return;
    const flip = raw < 0;
    const optional = (path: string | undefined, fallback?: string) => text(at(path, item)) ?? fallback;
    const dimensions = (line.dimension === undefined ? [] : Array.isArray(line.dimension) ? line.dimension : [line.dimension]).map((d) => interpolate(d, payload, item));
    const composed: ComposedLine = {
      role: line.role, accountCode: line.account, dimension: dimensions[0], dimensionFallbacks: dimensions.length > 1 ? dimensions.slice(1) : undefined,
      side: flip ? (line.side === "debit" ? "credit" : "debit") : line.side,
      amountDoc: round2(Math.abs(amountDoc)), amountCompany,
      partyId: optional(line.party, header.partyId), costCenterId: optional(line.costCenter, header.costCenterId),
      openAuxiliaryId: optional(line.openAuxiliary, header.openAuxiliaryId), itemId: optional(line.item, header.itemId),
      businessUnitId: optional(line.businessUnit, header.businessUnitId),
      description: line.description ? interpolate(line.description, payload, item) : undefined,
      taxCode: optional(line.taxCode), taxRate: line.taxRate ? numberOf(at(line.taxRate, item), "taxRate") : undefined,
      taxBase: line.taxBase ? numberOf(at(line.taxBase, item), "taxBase") : undefined,
      reference: optional(line.reference), dueDate: optional(line.dueDate),
    };
    lines.push(Object.fromEntries(Object.entries(composed).filter(([, v]) => v !== undefined)) as unknown as ComposedLine);
  };
  for (const line of t.lines) {
    if (line.forEach === undefined) { compose(line); continue; }
    const items = resolvePath(payload, line.forEach);
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new Invalid(`forEach ${line.forEach} does not resolve to a list`);
    for (const item of items) compose(line, item);
  }
  if (lines.length === 0) return { ok: false, code: "invalid_template", detail: "the template composes no lines" };

  const debit = lines.filter((l) => l.side === "debit").reduce((s, l) => s + cents(l.amountCompany), 0);
  const credit = lines.filter((l) => l.side === "credit").reduce((s, l) => s + cents(l.amountCompany), 0);
  const diff = debit - credit;
  if (Math.abs(diff) > Math.round(options.tolerance * 100)) {
    return { ok: false, code: "unbalanced", detail: `debit ${debit / 100} and credit ${credit / 100} differ by ${Math.abs(diff) / 100}` };
  }
  const entry: ComposedEntry = {
    date, description: interpolate(t.description, payload), currency, exchangeRate, ...Object.fromEntries(Object.entries(header).filter(([, v]) => v !== undefined)),
    lines, sourceEventId: event.id, chainId: event.chainId,
  };
  if (t.source) {
    const id = text(at(t.source.id));
    if (id) entry.source = { entity: t.source.entity, id };
  }
  if (diff !== 0) {
    const amount = Math.abs(diff) / 100;
    // The difference is of the company amounts: an entry in another currency carries it in pesos only (Task 34.4, FX §4).
    entry.roundingLine = { role: "rounding", side: diff > 0 ? "credit" : "debit", amountDoc: currency === options.companyCurrency ? amount : 0, amountCompany: amount };
  }
  return { ok: true, entry };
}
