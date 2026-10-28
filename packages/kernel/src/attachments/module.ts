import { defineModule } from "../module/define";
import type { ModuleDef } from "../registry/types";
import { CUSTOM_FIELD_PROCESSES } from "../custom-fields/processes";
import { VERIFY_PROCESSES } from "../verify";
import { ATTACHMENT_PROCESSES } from "./processes";

/**
 * The kernel as a module, so its processes are registered, audited and permissioned like any other.
 * It is the platform: `kernel.entitled` treats its processes as available to every company.
 */
export const kernelModule: ModuleDef = defineModule({
  id: "kernel",
  version: "0.1.0",
  dependsOn: [],
  entities: [],
  processes: [...ATTACHMENT_PROCESSES, ...CUSTOM_FIELD_PROCESSES, ...VERIFY_PROCESSES],
  features: [
    {
      id: "kernel.attachments",
      label: "feature.kernel.attachments",
      processes: ATTACHMENT_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: "kernel.custom_fields",
      label: "feature.kernel.custom_fields",
      processes: CUSTOM_FIELD_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: "kernel.verification",
      label: "feature.kernel.verification",
      processes: VERIFY_PROCESSES.map((p) => p.id),
      entities: [],
    },
  ],
  events: { emits: [], consumes: {} },
  navigation: [],
});
