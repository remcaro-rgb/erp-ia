// The Líneas tab of a Regla contable (accounting design §4.8, §5.2, §8): the rule template's lines as a grid. A line names a role or a
// fixed account (never both), a side and the paths of the event's payload that give the amount and the dimensions. Pure helpers.

export type RuleLine = { side: "debit" | "credit" } & Record<string, string | undefined>;

export interface LineColumn {
  key: string;
  /** The catalogue key of the column's name (snake case). */
  label: string;
  kind: "role" | "side" | "path";
  mono?: boolean;
}

export const RULE_COLUMNS: readonly LineColumn[] = [
  { key: "role", label: "role", kind: "role" },
  { key: "account", label: "account", kind: "path", mono: true },
  { key: "side", label: "side", kind: "side" },
  { key: "amount", label: "amount", kind: "path", mono: true },
  { key: "dimension", label: "dimension", kind: "path", mono: true },
  { key: "party", label: "party", kind: "path", mono: true },
  { key: "costCenter", label: "cost_center", kind: "path", mono: true },
  { key: "openAuxiliary", label: "open_auxiliary", kind: "path", mono: true },
  { key: "item", label: "item", kind: "path", mono: true },
  { key: "businessUnit", label: "business_unit", kind: "path", mono: true },
  { key: "taxCode", label: "tax_code", kind: "path", mono: true },
  { key: "taxRate", label: "tax_rate", kind: "path", mono: true },
  { key: "taxBase", label: "tax_base", kind: "path", mono: true },
];

export const blankRuleLine = (): RuleLine => ({ side: "debit", amount: "" });

/** Sets one cell. A role and a fixed account exclude each other: filling one empties the other. */
export function setLineField(lines: readonly RuleLine[], index: number, key: string, value: string): RuleLine[] {
  return lines.map((line, i) => {
    if (i !== index) return line;
    const next: RuleLine = { ...line, [key]: value };
    if (key === "role" && value !== "") next.account = undefined;
    if (key === "account" && value !== "") next.role = undefined;
    return next;
  });
}

/** The lines as the template schema takes them: empty paths dropped, the other keys of each line (forEach…) kept. */
export function cleanLines(lines: readonly RuleLine[]): RuleLine[] {
  return lines.map((line) => Object.fromEntries(Object.entries(line).filter(([key, v]) => key === "side" || (typeof v === "string" && v.trim() !== "")).map(([key, v]) => [key, typeof v === "string" ? v.trim() : v])) as RuleLine);
}

/** Whether every line names a role or an account (the schema's own rule) and has an amount path. */
export function linesIncomplete(lines: readonly RuleLine[]): boolean {
  return lines.length === 0 || lines.some((l) => (!l.role?.trim() && !l.account?.trim()) || !l.amount?.trim());
}

/** The input of `accounting.posting_rule.update` that replaces the template's lines and keeps the rest of the template. */
export function ruleLinesInput(id: string, template: Readonly<Record<string, unknown>>, lines: readonly RuleLine[]): Record<string, unknown> {
  return { id, template: { ...template, lines: cleanLines(lines) } };
}

/** The lines of a stored template (anything else is no lines). */
export function linesOf(template: unknown): RuleLine[] {
  const lines = (template as { lines?: unknown } | null)?.lines;
  return Array.isArray(lines) ? (lines as RuleLine[]) : [];
}
