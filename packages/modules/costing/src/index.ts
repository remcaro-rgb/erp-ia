import { HOME_KPIS } from "./home";
import { defineModule, type ModuleDef } from "@erp/kernel";
import { COSTING_ENTITIES } from "./entities";
import { FEATURES, MENU_SHARED, NAVIGATION } from "./features";
import { COSTING_PROCESSES } from "./processes";
import { COGS_POSTED, COGS_RETURNED, onMovementPosted } from "./processes/cost";
import { COGS_RETURN_VOIDED, COGS_VOIDED, onMovementVoided } from "./processes/void";
import { LANDED_COST_ALLOCATED, LANDED_COST_VOIDED, landedCostHooks } from "./processes/landed-cost";
import { COSTING_POSTING_RULES } from "./rules";

/**
 * The costing module (design §8, §8.1, plan 2B Task 8): the weighted average cost of every product per bodega, valued from the inventory
 * movements (inventory.movement.posted, in the inventory's own order), the products moved without a cost, and the cost of sales of every
 * sale issue (costing.cogs.posted, which the 2A rule `cogs-posted` of accounting posts: Dr cogs / Cr inventory). No module is named here:
 * inventory publishes its movements (event and feed), accounting consumes the COGS event (rule 3). Weighted average only (OD-5);
 * landed costs (Task 9) raise the value of a receipt's layers and post Dr inventory / Cr the offset role through the rules this manifest
 * ships (Task 45: the share of units already sold goes to cost of sales, Dr cogs, in the same entry); FIFO is phase 3. Every void of a movement (inventory.movement.voided, Task 14) takes its cost back with opposite cost events; a
 * voided sale issue (sale return) whose cost of sales left reverses it (costing.cogs.voided / costing.cogs.return_voided, rules `reverseOf`),
 * and a sale return's cost of sales leaves as costing.cogs.returned (Dr inventory / Cr cogs at the original issue's cost).
 */
export const costing: ModuleDef = defineModule({
  id: "costing",
  version: "0.1.0",
  dependsOn: ["core", "inventory"],
  icon: "coins",
  entities: COSTING_ENTITIES,
  processes: COSTING_PROCESSES,
  features: FEATURES,
  // Its Inicio cards (plan 2B Task 26).
  homeKpis: HOME_KPIS,
  events: {
    emits: [COGS_POSTED, COGS_RETURNED, COGS_VOIDED, COGS_RETURN_VOIDED, LANDED_COST_ALLOCATED, LANDED_COST_VOIDED],
    consumes: { "inventory.movement.posted": onMovementPosted, "inventory.movement.voided": onMovementVoided },
  },
  navigation: NAVIGATION,
  menuShared: MENU_SHARED,
  // The landed cost numbers on save and posts in the action that allocates it (entity types spec §5).
  typedHooks: { "costing.landed_cost": landedCostHooks },
  postingRules: COSTING_POSTING_RULES,
  // What the assistant's confirmation card tells about costs (plan 2B Task 25). Costing values every inventory movement (its consumers);
  // a sales delivery or return reaches it through inventory's movement, so the card of the sales document names the cost of sales too
  // (by event name only, rule 3).
  effects: {
    "inventory.movement.posted": ["costing.effects.movement_cost"],
    "inventory.movement.voided": ["costing.effects.movement_void_cost"],
    "sales.delivery.shipped": ["costing.effects.delivery_cogs"],
    "sales.delivery.voided": ["costing.effects.delivery_void_cogs"],
    "sales.return.received": ["costing.effects.return_cogs"],
    "sales.return.voided": ["costing.effects.return_void_cogs"],
    // Task 45 (R45-7): a landed cost raises the units still in stock and sends the share of the units already sold to cost of sales.
    "costing.landed_cost.allocate": ["costing.effects.landed_stock", "costing.effects.landed_cogs"],
    "costing.landed_cost.void": ["costing.effects.landed_void"],
  },
});

export { COSTING_ENTITIES, COST_METHODS, COST_SOURCES, EVENT_KINDS, LANDED_BASES, OFFSET_ROLES } from "./entities";
export type { CostSource, EventKind, LandedBasis, OffsetRole } from "./entities";
export { CostError, enter, exit, reverse, revalue } from "./average";
export { distribute } from "./allocation";
export { LANDED_COST_ALLOCATED, LANDED_COST_VOIDED } from "./processes/landed-cost";
export type { LandedCostEvent } from "./processes/landed-cost";
export { FIFO_PHASE_3 } from "./processes/settings";
export { COSTING_POSTING_RULES } from "./rules";
export type { Layer } from "./average";
export { COGS_POSTED, COGS_RETURNED, cogsPayload } from "./processes/cost";
export { COGS_RETURN_VOIDED, COGS_VOIDED } from "./processes/void";
export type { CogsVoidEvent } from "./processes/void";
export type { CogsEvent, CogsLine } from "./processes/cost";
