import { ATTACHMENT_PROCESSES } from "../attachments/processes";
import { defineModule } from "./define";
import type { ModuleDef } from "../registry/types";
import { CUSTOM_FIELD_PROCESSES } from "../custom-fields/processes";
import { VERIFY_PROCESSES } from "../verify";
import { USER_PREF_PROCESSES } from "../user-prefs";
import { SAVED_VIEW_PROCESSES } from "../saved-views";

/**
 * The kernel as a module, so its processes are registered, audited and permissioned like any other.
 * It is the platform: `kernel.entitled` treats its processes as available to every company.
 */
export const kernelModule: ModuleDef = defineModule({
  id: "kernel",
  version: "0.1.0",
  dependsOn: [],
  entities: [],
  processes: [...ATTACHMENT_PROCESSES, ...CUSTOM_FIELD_PROCESSES, ...VERIFY_PROCESSES, ...USER_PREF_PROCESSES, ...SAVED_VIEW_PROCESSES],
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
    {
      id: "kernel.user_prefs",
      label: "feature.kernel.user_prefs",
      processes: USER_PREF_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: "kernel.saved_views",
      label: "feature.kernel.saved_views",
      processes: SAVED_VIEW_PROCESSES.map((p) => p.id),
      entities: [],
    },
  ],
  events: { emits: [], consumes: {} },
  navigation: [],
});
