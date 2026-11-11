import { defineProcess, defineReport, type ProcessContext, type ReportColumn, type ReportState } from "@erp/kernel";
import { z } from "zod";
import { balanceRows, cents, dimensionParams, foldRestricted, level, orderedRange, periodBounds, reportInput, reportOutput, RESTRICTED_CODE, RESTRICTED_NAME, windowOf, type BalanceRow } from "./common";

// Balance de prueba (accounting design §6, plan Task 22) and Libro mayor y balances: opening, movement and closing per account at
// a level of the chart, with the restricted accounts folded into one line so the totals equal the admin's (§5.13).

const MONEY = ["opening_debit", "opening_credit", "debit", "credit", "closing_debit", "closing_credit"] as const;

const columns: ReportColumn[] = [
  { field: "account_code", label: "report.col.account_code", type: "text", mono: true, link: { entity: "accounting.account", idField: "account_id" } },
  { field: "account_name", label: "report.col.account_name", type: "text" },
  ...MONEY.map((field) => ({ field, label: `report.col.${field}`, type: "money" as const, currency: "company" as const, total: "sum" as const, mono: true })),
];

export const trialBalanceParams = z.object({
  from: z.uuid(),
  to: z.uuid(),
  level,
  ...dimensionParams,
  includeOpening: z.boolean().default(true),
  includeClosing: z.boolean().default(false),
  onlyWithMovement: z.boolean().default(true),
});
export type TrialBalanceParams = z.infer<typeof trialBalanceParams>;

interface Folded extends BalanceRow {
  restricted: boolean;
  /** Each folded account contributes its own debit and credit side, so the line's columns add up to the admin's. */
  sides: Record<(typeof MONEY)[number], number>;
}

function sidesOf(row: BalanceRow): Folded["sides"] {
  const closingNet = row.openingNet + row.debit - row.credit;
  return {
    opening_debit: Math.max(row.openingNet, 0),
    opening_credit: Math.max(-row.openingNet, 0),
    debit: row.debit,
    credit: row.credit,
    closing_debit: Math.max(closingNet, 0),
    closing_credit: Math.max(-closingNet, 0),
  };
}

function toRow(row: BalanceRow, count?: number, sides: Folded["sides"] = sidesOf(row)): Record<string, unknown> {
  return {
    account_id: row.nodeId,
    account_code: row.code,
    account_name: row.name,
    ...Object.fromEntries(MONEY.map((field) => [field, cents(sides[field])])),
    is_restricted: row.restricted,
    ...(count === undefined ? {} : { n: count }),
  };
}

/** The rows of a balances report for the range of two periods; shared with the Libro mayor y balances. */
export async function trialBalanceRows(ctx: ProcessContext, p: Omit<TrialBalanceParams, "from" | "to"> & { from: string; to: string }): Promise<{ rows: Record<string, unknown>[]; restricted: number }> {
  const from = await periodBounds(ctx, p.from);
  const to = await periodBounds(ctx, p.to);
  orderedRange(from, to);
  const all = await balanceRows(ctx, {
    from: from.startsOn, to: to.endsOn, level: p.level, includeOpening: p.includeOpening, includeClosing: p.includeClosing,
    costCenterId: p.costCenterId, openAuxiliaryId: p.openAuxiliaryId, itemId: p.itemId, businessUnitId: p.businessUnitId, partyId: p.partyId,
  });
  const nonZero = (r: BalanceRow) => r.openingNet !== 0 || r.debit !== 0 || r.credit !== 0 || r.openingNet + r.debit - r.credit !== 0;
  const wanted = p.onlyWithMovement ? all.filter(nonZero) : all;
  const folded = foldRestricted<Folded>(
    wanted.map((r) => ({ ...r, sides: sidesOf(r) })),
    () => ({ nodeId: null, code: RESTRICTED_CODE, name: RESTRICTED_NAME, nature: null, section: null, restricted: true, openingNet: 0, debit: 0, credit: 0, sides: { opening_debit: 0, opening_credit: 0, debit: 0, credit: 0, closing_debit: 0, closing_credit: 0 } }),
    (acc, row) => {
      acc.openingNet += row.openingNet;
      acc.debit += row.debit;
      acc.credit += row.credit;
      for (const field of MONEY) acc.sides[field] += row.sides[field];
    },
  );
  const rows = folded.visible.map((r) => toRow(r, undefined, r.sides));
  if (folded.restricted) rows.push(toRow(folded.restricted, folded.count, folded.restricted.sides));
  return { rows, restricted: folded.count };
}

const consultOf = (id: string, description: string, params: z.ZodObject, build: (ctx: ProcessContext, params: never) => Promise<{ rows: Record<string, unknown>[]; restricted: number }>) =>
  defineProcess({
    id,
    module: "accounting",
    kind: "consult",
    feature: "accounting.ledger",
    description,
    input: reportInput(params),
    output: reportOutput,
    handler: async (ctx, input) => {
      const { rows, restricted } = await build(ctx, input.params as never);
      return windowOf(rows, input.state as ReportState, { totals: MONEY, extra: { restricted } });
    },
  });

export const trialBalanceConsult = consultOf(
  "accounting.report.trial_balance",
  "Balance de prueba: saldo inicial, movimiento y saldo final por cuenta hasta un nivel del plan; las cuentas restringidas se suman en una línea",
  trialBalanceParams,
  (ctx, params: TrialBalanceParams) => trialBalanceRows(ctx, params),
);

export const trialBalanceReport = defineReport({
  id: "accounting.trial_balance",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.trial_balance",
  params: trialBalanceParams,
  consult: "accounting.report.trial_balance",
  columns,
  totals: [...MONEY],
  pdfTitle: "Balance de prueba",
});

// Libro mayor y balances: one period, the same figures.
export const ledgerParams = z.object({ period: z.uuid(), level });
export const ledgerConsult = consultOf(
  "accounting.report.ledger",
  "Libro mayor y balances de un período: saldo inicial, movimiento y saldo final por cuenta hasta un nivel del plan",
  ledgerParams,
  (ctx, params: z.infer<typeof ledgerParams>) =>
    trialBalanceRows(ctx, { from: params.period, to: params.period, level: params.level, includeOpening: true, includeClosing: false, onlyWithMovement: true }),
);
export const ledgerReport = defineReport({
  id: "accounting.ledger",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.ledger",
  params: ledgerParams,
  consult: "accounting.report.ledger",
  columns,
  totals: [...MONEY],
  pdfTitle: "Libro mayor y balances",
});
