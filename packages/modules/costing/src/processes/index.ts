import { CONSULT_PROCESSES } from "./consult";
import { COST_PROCESSES } from "./cost";
import { LANDED_COST_PROCESSES } from "./landed-cost";
import { SETTINGS_PROCESSES } from "./settings";
import { VOID_PROCESSES } from "./void";

export const COSTING_PROCESSES = [...COST_PROCESSES, ...CONSULT_PROCESSES, ...LANDED_COST_PROCESSES, ...SETTINGS_PROCESSES, ...VOID_PROCESSES];
