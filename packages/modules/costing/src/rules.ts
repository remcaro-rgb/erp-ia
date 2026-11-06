import type { DefaultPostingRule } from "@erp/kernel";
import { OFFSET_ROLES } from "./entities";

// The default posting rules the costing module ships (accounting design §5.4; `accounting.posting_rule.sync` installs them for a company
// that has costing on, and switches them off with the module). Landed costs: costing.landed_cost.allocated posts Dr inventory (one line per
// receipt line, its share) / Cr the offset role the request names. A rule line names its role literally, so there is one rule per offset
// role, each with a `when` on the payload's offsetRole: exactly one applies to an event. Anular posts nothing of its own: the rule
// `reverseOf` on costing.landed_cost.voided reverses the entry of the allocation (a reversal rule has no `when`, it finds the entry by source).

const ROLE_NAMES: Record<(typeof OFFSET_ROLES)[number], string> = {
  payable: "cuentas por pagar",
  supplier_advances: "anticipos a proveedores",
  cash: "caja",
  bank: "bancos",
  suspense: "cuenta transitoria",
};

const allocated = (role: (typeof OFFSET_ROLES)[number]): DefaultPostingRule => ({
  event: "costing.landed_cost.allocated",
  name: `Costo en destino (${ROLE_NAMES[role]})`,
  journalCode: "CP",
  template: {
    date: "$.date",
    description: "Costo en destino {{number}}",
    source: { entity: "costing.landed_cost", id: "$.landedCostId" },
    lines: [
      { role: "inventory", side: "debit", forEach: "$.lines[*]", amount: "$.cost" },
      { role, side: "credit", amount: "$.amount", party: "$.partyId" },
    ],
    reverseOf: null,
    when: [{ path: "$.offsetRole", equals: role }],
  },
});

const voided: DefaultPostingRule = {
  event: "costing.landed_cost.voided",
  name: "Anulación de costo en destino",
  journalCode: "CP",
  template: {
    date: "$.date",
    description: "Anulación del costo en destino {{number}}",
    lines: [],
    reverseOf: { event: "costing.landed_cost.allocated", sourceId: "$.landedCostId" },
  },
};

// The cost of sales of the entregas (Task 14). A sale issue's cost of sales (costing.cogs.posted) is posted by accounting's own 2A rule
// `cogs-posted`; a sale return's goes back the other way at the original issue's cost (Dr inventory / Cr cogs, on the cost center the
// devolución carries); a voided sale issue or sale return reverses the entry of its cost of sales (`reverseOf`, found by its movement).
const returned: DefaultPostingRule = {
  event: "costing.cogs.returned",
  name: "Devolución del costo de ventas",
  journalCode: "NC",
  template: {
    date: "$.date",
    description: "Devolución de ventas {{number}}",
    source: { entity: "inventory.movement", id: "$.movementId" },
    lines: [
      { role: "inventory", side: "debit", forEach: "$.lines[*]", amount: "$.cost" },
      { role: "cogs", side: "credit", forEach: "$.lines[*]", amount: "$.cost", costCenter: "$.costCenterId" },
    ],
    reverseOf: null,
  },
};

const cogsVoided: DefaultPostingRule = {
  event: "costing.cogs.voided",
  name: "Anulación del costo de ventas",
  journalCode: "NC",
  template: {
    date: "$.date",
    description: "Anulación del costo de ventas {{number}}",
    lines: [],
    reverseOf: { event: "costing.cogs.posted", sourceId: "$.movementId" },
  },
};

const returnVoided: DefaultPostingRule = {
  event: "costing.cogs.return_voided",
  name: "Anulación de la devolución del costo de ventas",
  journalCode: "NC",
  template: {
    date: "$.date",
    description: "Anulación de la devolución de ventas {{number}}",
    lines: [],
    reverseOf: { event: "costing.cogs.returned", sourceId: "$.movementId" },
  },
};

export const COSTING_POSTING_RULES: DefaultPostingRule[] = [...OFFSET_ROLES.map(allocated), voided, returned, cogsVoided, returnVoided];
