import { defineProcess, defineReport, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { settingsOf } from "../processes/common";
import { controlReconciliation } from "./control-reconciliation";
import { cents, reportInput, reportOutput, RESTRICTED_PARTIES, windowOf } from "./common";

// Conciliación de controles (accounting design §5.12.3, §5.12.4): receivable and payable by party against the open items, inventory
// against the stock value, the suspense account and the rounding account. The same figures `period.close` checks.

const params = z.object({ asOf: z.iso.date() });

const columns: ReportColumn[] = [
  { field: "control", label: "report.col.control", type: "text" },
  { field: "subject", label: "report.col.subject", type: "text" },
  { field: "ledger", label: "report.col.ledger", type: "money", mono: true },
  { field: "subledger", label: "report.col.subledger", type: "money", mono: true },
  { field: "difference", label: "report.col.difference", type: "money", mono: true },
];

export const controlReconciliationConsult = defineProcess({
  id: "accounting.report.control_reconciliation",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Conciliación de controles a una fecha: cuentas por cobrar y por pagar contra partidas abiertas, inventario contra existencias, cuenta transitoria y ajuste al peso",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const settings = await settingsOf(ctx);
    const tolerance = settings?.roundingTolerance ?? 0;
    const control = await controlReconciliation(ctx, p.asOf, `${p.asOf.slice(0, 8)}01`, tolerance);
    const ids = [...new Set([...control.receivable.parties, ...control.payable.parties].map((r) => r.partyId).filter((id) => id !== ""))];
    const names = new Map(
      (ids.length === 0 ? [] : await ctx.tx<{ id: string; legal_name: string | null }[]>`select id, legal_name from core.v_parties where id = any(${ids}::uuid[])`).map((r) => [r.id, r.legal_name ?? ""]),
    );
    const rows: Record<string, unknown>[] = [];
    for (const [control_, side] of [["receivable", control.receivable], ["payable", control.payable]] as const) {
      for (const r of side.parties) {
        // A line a record rule hides from the caller (D11): compared and counted under the lock, never named.
        const subject = r.restricted ? RESTRICTED_PARTIES : (names.get(r.partyId) ?? r.partyId);
        rows.push({ control: control_, subject, party_id: r.restricted ? null : r.partyId, account_code: r.accountCode, ledger: cents(r.ledger), subledger: cents(r.open), difference: cents(r.ledger - r.open) });
      }
    }
    if (control.inventory.available) {
      rows.push({ control: "inventory", subject: "inventory", ledger: cents(control.inventory.ledger), subledger: cents(control.inventory.stock), difference: cents(control.inventory.difference) });
    }
    if (control.suspense.mapped) {
      if (control.suspense.accounts.length === 0) rows.push({ control: "suspense", subject: "", ledger: 0, subledger: 0, difference: 0 });
      for (const a of control.suspense.accounts) rows.push({ control: "suspense", subject: `${a.code} · ${a.name}`, account_id: a.accountId, ledger: cents(a.balance), subledger: 0, difference: cents(a.balance) });
    }
    if (control.rounding.mapped) rows.push({ control: "rounding", subject: "", ledger: cents(control.rounding.net), subledger: 0, difference: cents(control.rounding.net) });
    return windowOf(rows, state, {
      extra: {
        tolerance, differences: control.receivable.differences.length + control.payable.differences.length, suspense: cents(control.suspense.balance),
        oversizedRounding: control.rounding.oversized.length + control.rounding.oversizedHidden,
      },
    });
  },
});

export const controlReconciliationReport = defineReport({
  id: "accounting.control_reconciliation",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.control_reconciliation",
  params,
  consult: "accounting.report.control_reconciliation",
  columns,
  pdfTitle: "Conciliación de controles",
});
