import { defineProcess, ProcessError } from "@erp/kernel";
import { z } from "zod";

// Document numbers (design §5.7): draws the next number of a (document type, prefix) sequence of the
// caller's company through core.next_sequence, which locks the row, so numbers are consecutive and
// commit or roll back with the document that uses them.

/** SQLSTATE raised by core.next_sequence when the company has no such sequence. */
const NO_DATA_FOUND = "P0002";

export const sequenceNext = defineProcess({
  id: "core.sequence.next",
  module: "core",
  kind: "update",
  recordAccess: "none",
  feature: "core.settings",
  description: "Toma el siguiente número de una numeración de documentos",
  input: z.object({ documentType: z.string().trim().min(1).max(20), prefix: z.string().max(20) }),
  output: z.object({ number: z.string() }),
  handler: async (ctx, { documentType, prefix }) => {
    try {
      const [row] = await ctx.tx<{ number: string }[]>`select core.next_sequence(${ctx.companyId}, ${documentType}, ${prefix}) as number`;
      return { number: row!.number };
    } catch (error) {
      if ((error as { code?: string }).code === NO_DATA_FOUND) {
        throw new ProcessError("not_found", `no document sequence ${documentType} / ${prefix}`);
      }
      throw error;
    }
  },
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Usa una fecha AAAA-MM-DD").refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, "La fecha no existe");
const DOCUMENT_TYPES = ["invoice", "credit_note", "debit_note"] as const;

/** The DIAN resolution of a numbering (Task 3's shape; core.valid_resolution holds it in the database). */
const resolutionInput = z.object({
  number: z.string().trim().min(1).max(40),
  from: z.number().int().min(1).max(999_999_999_999),
  to: z.number().int().min(1).max(999_999_999_999),
  validFrom: isoDate,
  validTo: isoDate,
  technicalKey: z.string().trim().min(1).max(200),
}).strict()
  .refine((r) => r.to >= r.from, { message: "El rango de la resolución termina antes de empezar («hasta» es menor que «desde»)", path: ["to"] })
  .refine((r) => r.validTo >= r.validFrom, { message: "La resolución vence antes de entrar en vigencia", path: ["validTo"] });

/**
 * Registers a numbering (plan 2B Task 19; Parámetros de facturación): the DIAN resolution of the invoices of a prefix (number, range,
 * validity, technical key; a renewal replaces the resolution of the same prefix), or the numbering row of credit or debit notes (no
 * resolution: Task 18). STEP-UP. The counter never goes back; a new row starts at the resolution's first number. The technical key is
 * never answered back (only its last characters): it signs every CUFE.
 */
export const documentSequenceRegister = defineProcess({
  id: "core.document_sequence.register",
  module: "core",
  kind: "update",
  recordAccess: "none",
  feature: "core.settings",
  sensitivity: "step-up",
  // Task 19 fix round 2: from the Parámetros screen only (the assistant gets no tool: the key would reach the model), and the audit keeps
  // the key's last characters, never the key.
  origins: ["ui"],
  auditInput: (input) => ({
    ...input,
    ...(input.resolution ? { resolution: { ...input.resolution, technicalKey: `[clave técnica …${input.resolution.technicalKey.slice(-4)}]` } } : {}),
  }),
  description:
    "Registra una numeración de documentos: la resolución DIAN de facturación de un prefijo (número, rango autorizado, vigencia y clave técnica) o la numeración de las notas crédito y débito; el consecutivo nunca retrocede",
  input: z.object({
    documentType: z.enum(DOCUMENT_TYPES),
    prefix: z.string().trim().max(4).regex(/^[A-Z0-9]*$/, "El prefijo va en mayúsculas y números, hasta 4 caracteres").default(""),
    nextNumber: z.number().int().min(1).max(999_999_999_999).optional(),
    resolution: resolutionInput.nullable().optional(),
  }).strict().superRefine((input, issue) => {
    if (input.documentType === "invoice" && !input.resolution) issue.addIssue({ code: "custom", path: ["resolution"], message: "La numeración de facturas necesita su resolución DIAN" });
    if (input.resolution && input.nextNumber !== undefined && (input.nextNumber < input.resolution.from || input.nextNumber > input.resolution.to + 1)) {
      issue.addIssue({ code: "custom", path: ["nextNumber"], message: "El siguiente número queda fuera del rango de la resolución" });
    }
  }),
  output: z.object({
    id: z.string(),
    documentType: z.enum(DOCUMENT_TYPES),
    prefix: z.string(),
    nextNumber: z.number(),
    resolution: z.object({ number: z.string(), prefix: z.string(), from: z.number(), to: z.number(), validFrom: z.string(), validTo: z.string() }).nullable(),
    technicalKeyEnding: z.string().nullable(),
  }),
  handler: async (ctx, input) => {
    // Task 19 fix round 2: the company admin's only, whatever the role matrix grants (the page is not the only way in).
    const [who] = await ctx.tx<{ admin: boolean }[]>`select kernel.is_company_admin() as admin`;
    if (!who?.admin) throw new ProcessError("forbidden", "Solo el administrador de la empresa registra las numeraciones y resoluciones DIAN");
    const resolution = input.resolution ? { ...input.resolution, prefix: input.prefix } : null;
    if (resolution) {
      const [today] = await ctx.tx<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`;
      if (resolution.validTo < today!.d) throw new ProcessError("invalid_input", "La resolución ya está vencida: registra la resolución vigente", { details: [{ path: ["resolution", "validTo"], message: "La resolución ya está vencida" }] });
    }
    type Registered = { id: string; documentType: (typeof DOCUMENT_TYPES)[number]; prefix: string; nextNumber: number; resolution: Record<string, unknown> | null };
    let row: Registered | undefined;
    try {
      [row] = (await ctx.tx<{ r: Registered }[]>`
        select core.register_document_sequence(${ctx.companyId}, ${input.documentType}, ${input.prefix}, ${input.nextNumber ?? null}, ${resolution ? ctx.tx.json(resolution as never) : null}) as r`).map((x) => x.r);
    } catch (error) {
      const message = (error as { message?: string }).message ?? "";
      if (message.startsWith("sequence_rewind")) throw new ProcessError("invalid_input", "El consecutivo no puede retroceder: ya se emitieron documentos con números más altos", { details: [{ path: ["nextNumber"], message: "El consecutivo no puede retroceder: ya se emitieron documentos con números más altos" }] });
      throw error;
    }
    const r = row!.resolution;
    return {
      id: row!.id, documentType: row!.documentType, prefix: row!.prefix, nextNumber: Number(row!.nextNumber),
      resolution: r ? { number: String(r.number), prefix: String(r.prefix), from: Number(r.from), to: Number(r.to), validFrom: String(r.validFrom), validTo: String(r.validTo) } : null,
      // The key itself is kept in core.document_resolution_keys (migration 0104); the row carries its last characters.
      technicalKeyEnding: r && typeof r.technicalKeyEnding === "string" ? r.technicalKeyEnding : null,
    };
  },
});

export const SEQUENCE_PROCESSES = [sequenceNext, documentSequenceRegister];
