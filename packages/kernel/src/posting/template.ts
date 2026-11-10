import { z } from "zod";

const wildcards = (path: string): number => (path.match(/\[\*\]/g) ?? []).length;
const path = z.string().min(1);

export const RuleLine = z
  .object({
    role: path.optional(),
    account: path.optional(),
    side: z.enum(["debit", "credit"]),
    amount: path,
    amountCompany: path.optional(),
    forEach: path.optional(),
    /** One dimension, or an ordered list (Task 34.8b, owner item 135): the first one mapped for the role wins, then the role alone. */
    dimension: z.union([path, z.array(path).min(1).max(4)]).optional(),
    party: path.optional(),
    costCenter: path.optional(),
    openAuxiliary: path.optional(),
    item: path.optional(),
    businessUnit: path.optional(),
    description: path.optional(),
    taxCode: path.optional(),
    taxRate: path.optional(),
    taxBase: path.optional(),
    reference: path.optional(),
    dueDate: path.optional(),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (Boolean(line.role) === Boolean(line.account)) ctx.addIssue({ code: "custom", message: "a line names a role or an account, not both and not neither" });
    if (line.forEach !== undefined && (!line.forEach.startsWith("$") || wildcards(line.forEach) !== 1)) {
      ctx.addIssue({ code: "custom", path: ["forEach"], message: "forEach needs a path with exactly one [*]" });
    }
    for (const [key, value] of Object.entries(line)) {
      const values = Array.isArray(value) ? value : [value];
      if (key !== "forEach" && values.some((v) => typeof v === "string" && wildcards(v) > 0)) ctx.addIssue({ code: "custom", path: [key], message: "[*] is only allowed in forEach" });
    }
  });
export type RuleLine = z.infer<typeof RuleLine>;

/**
 * A condition on the event payload (plan 2B Task 7): `equals`, `in` or `notEquals` (exactly one) compared with the value at `path`
 * (a `$.` path without `[*]`), no type coercion. A missing value equals nothing.
 */
export const RuleCondition = z
  .object({ path, equals: z.unknown().optional(), in: z.array(z.unknown()).optional(), notEquals: z.unknown().optional() })
  .strict()
  .superRefine((condition, ctx) => {
    if (!/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(condition.path)) ctx.addIssue({ code: "custom", path: ["path"], message: "a condition path looks like $.a.b (no [*])" });
    if (wildcards(condition.path) > 0) ctx.addIssue({ code: "custom", path: ["path"], message: "[*] is not allowed in a condition" });
    const operators = (["equals", "in", "notEquals"] as const).filter((key) => key in condition && condition[key] !== undefined);
    if (operators.length !== 1) ctx.addIssue({ code: "custom", message: "a condition has exactly one of equals, in, notEquals" });
  });
export type RuleCondition = z.infer<typeof RuleCondition>;

export const RuleTemplate = z
  .object({
    date: path.optional(),
    description: path,
    party: path.optional(),
    costCenter: path.optional(),
    openAuxiliary: path.optional(),
    item: path.optional(),
    businessUnit: path.optional(),
    currency: path.optional(),
    exchangeRate: path.optional(),
    source: z.object({ entity: path, id: path }).strict().optional(),
    lines: z.array(RuleLine),
    reverseOf: z.object({ event: path, sourceId: path }).strict().nullable().optional(),
    /** The rule applies to an event only when every condition holds on its payload (e.g. `kind` equals `adjustment`). */
    when: z.array(RuleCondition).optional(),
  })
  .strict()
  .superRefine((template, ctx) => {
    if (!template.reverseOf && template.lines.length === 0) ctx.addIssue({ code: "custom", path: ["lines"], message: "a rule needs at least one line unless it reverses another" });
  });
export type RuleTemplate = z.infer<typeof RuleTemplate>;
