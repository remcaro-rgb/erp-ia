import { z } from "zod";
import { CUSTOM_FIELD_TYPES } from "./types";

// Zod schemas of the custom-field processes and of the free extra data every entity process accepts.

const roles = z.array(z.uuid()).max(100).default([]);

/** `extra_free` (design §5.14): name/value pairs any user may add; both texts at most 200 characters, no role rules. */
export const extraFree = z
  .array(z.object({ name: z.string().trim().min(1).max(200), value: z.string().max(200) }))
  .max(100)
  .optional();

export const entityInput = z.object({ entity: z.string().min(1) });

export const setInput = z
  .object({
    entity: z.string().min(1),
    /** Where the value lives inside `extra`. */
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "La clave usa minúsculas, números y _ (máximo 40)"),
    label: z.string().trim().min(1).max(100),
    type: z.enum(CUSTOM_FIELD_TYPES),
    maxLength: z.number().int().min(1).max(1000).nullable().optional(),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
    rolesEnter: roles,
    rolesEdit: roles,
    rolesView: roles,
  })
  .superRefine((input, ctx) => {
    if (input.type === "list" && (input.options ?? []).length === 0) ctx.addIssue({ code: "custom", path: ["options"], message: "La lista necesita opciones" });
    if (input.type !== "list" && input.options !== undefined) ctx.addIssue({ code: "custom", path: ["options"], message: "Solo una lista tiene opciones" });
  });

export const removeInput = z.object({ entity: z.string().min(1), key: z.string().min(1) });

export const idOutput = z.object({ id: z.string() });

const view = z.object({
  id: z.string(),
  entity: z.string(),
  key: z.string(),
  label: z.string(),
  type: z.enum(CUSTOM_FIELD_TYPES),
  maxLength: z.number().nullable(),
  required: z.boolean(),
  options: z.array(z.string()).nullable(),
  /** What the caller's own roles may do with the field: the form disables or hides accordingly. */
  canEnter: z.boolean(),
  canEdit: z.boolean(),
  canView: z.boolean(),
  /** The role lists, for the admin screen only; other callers receive null. */
  rolesEnter: z.array(z.string()).nullable(),
  rolesEdit: z.array(z.string()).nullable(),
  rolesView: z.array(z.string()).nullable(),
});
export const listOutput = z.array(view);
export type CustomFieldView = z.infer<typeof view>;
