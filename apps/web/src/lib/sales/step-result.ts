// What a creating step of the sales screens answers with (plan 2B Task 39, R39-4): the record to open next, or, for a conversion whose
// pedido the converter may not read (an owner other than the converter, no «all orders» permission: the process returns the trimmed
// `{ id, number, status, stage, ownerId, visible: false }`), only who it went to. Nothing is opened and nothing else is named: the pedido
// is not the converter's to see.

/** The record a creating step opens next. */
const CREATES: Readonly<Record<string, string>> = {
  "sales.order.from_quote": "sales.order",
  "sales.delivery.create": "sales.delivery",
  "sales.return.create": "sales.return",
};

export type StepResult = { created?: { entity: string; id: string; number: string | null }; handedOver?: { number: string | null; ownerId: string | null } };

export function stepResult(process: string, result: unknown): StepResult {
  const created = CREATES[process];
  const row = typeof result === "object" && result !== null ? (result as { id?: unknown; number?: unknown; ownerId?: unknown; visible?: unknown }) : null;
  if (!created || !row || typeof row.id !== "string") return {};
  const number = typeof row.number === "string" ? row.number : null;
  if (row.visible === false) return { handedOver: { number, ownerId: typeof row.ownerId === "string" ? row.ownerId : null } };
  return { created: { entity: created, id: row.id, number } };
}
