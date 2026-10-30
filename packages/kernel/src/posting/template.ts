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
    dimension: path.optional(),
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
      if (key !== "forEach" && typeof value === "string" && wildcards(value) > 0) ctx.addIssue({ code: "custom", path: [key], message: "[*] is only allowed in forEach" });
    }
  });
export type RuleLine = z.infer<typeof RuleLine>;

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
  })
  .strict()
  .superRefine((template, ctx) => {
    if (!template.reverseOf && template.lines.length === 0) ctx.addIssue({ code: "custom", path: ["lines"], message: "a rule needs at least one line unless it reverses another" });
  });
export type RuleTemplate = z.infer<typeof RuleTemplate>;
