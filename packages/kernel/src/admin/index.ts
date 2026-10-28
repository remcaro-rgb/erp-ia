import { MODULE_PROCESSES } from "./modules";
import { PERMISSION_PROCESSES } from "./permissions";
import { ROLE_PROCESSES } from "./roles";
import { SETTINGS_PROCESSES } from "./settings";
import { USAGE_PROCESSES } from "./usage";
import { USER_PROCESSES } from "./users";

// Administration (design §6, §5.12–§5.18): the kernel.admin.* processes and the admin's settings processes
// (kernel.required_file.*, kernel.verifier.set), all of feature kernel.admin and all asking for the step-up (rule 15).

export const ADMIN_PROCESSES = [...ROLE_PROCESSES, ...USER_PROCESSES, ...PERMISSION_PROCESSES, ...MODULE_PROCESSES, ...USAGE_PROCESSES, ...SETTINGS_PROCESSES];

export { ADMIN_FEATURE } from "./common";
export { authAdmin, setAuthAdmin } from "./auth-admin";
export { matrixProcess, matrixProcesses } from "./matrix";
export type { MatrixProcess } from "./matrix";
export { moduleStates } from "./modules-state";
export type { ModuleState } from "./modules-state";
export { syncRegistry } from "./sync";
export { readAiUsage } from "./usage";
export type { AiUsage } from "./usage";
export { readPermissionMatrix } from "./permissions";
export type { PermissionMatrix } from "./permissions";
