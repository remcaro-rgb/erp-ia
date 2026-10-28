import { defineModule } from "../module/define";
import type { ModuleDef } from "../registry/types";
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
  processes: ATTACHMENT_PROCESSES,
  features: [
    {
      id: "kernel.attachments",
      label: "feature.kernel.attachments",
      processes: ATTACHMENT_PROCESSES.map((p) => p.id),
      entities: [],
    },
  ],
  events: { emits: [], consumes: {} },
  navigation: [],
});
