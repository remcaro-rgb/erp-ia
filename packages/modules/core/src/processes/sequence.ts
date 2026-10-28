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

export const SEQUENCE_PROCESSES = [sequenceNext];
