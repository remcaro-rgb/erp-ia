import { AI_PROCESSES } from "../ai/image-suggest";
import { ATTACHMENT_PROCESSES } from "../attachments/processes";
import { defineModule } from "./define";
import type { ModuleDef } from "../registry/types";
import { CUSTOM_FIELD_PROCESSES } from "../custom-fields/processes";
import { VERIFY_PROCESSES } from "../verify";
import { USER_PREF_PROCESSES } from "../user-prefs";
import { SAVED_VIEW_PROCESSES } from "../saved-views";
import { importEntity } from "../import/entity";
import { IMPORT_PROCESSES } from "../import/processes";
import { exportJobEntity } from "../exports/entity";
import { EXPORT_PROCESSES } from "../exports/export.process";
import { HELP_PROCESSES } from "../help/help.process";
import { DATA_PROCESSES } from "../query/data-query.process";
import { ADMIN_FEATURE, ADMIN_PROCESSES } from "../admin";
import { ADMIN_NAVIGATION } from "../admin/navigation";
import { HOME_FEATURE, HOME_PROCESSES, KERNEL_KPI_PROVIDERS } from "../home";
import { AUDIT_FEATURE, AUDIT_PROCESSES, auditEntity } from "../audit/viewer";

/**
 * The kernel as a module, so its processes are registered, audited and permissioned like any other.
 * It is the platform: `kernel.entitled` treats its processes as available to every company.
 */
export const kernelModule: ModuleDef = defineModule({
  id: "kernel",
  version: "0.1.0",
  dependsOn: [],
  entities: [importEntity, exportJobEntity, auditEntity],
  processes: [...ATTACHMENT_PROCESSES, ...AI_PROCESSES, ...CUSTOM_FIELD_PROCESSES, ...VERIFY_PROCESSES, ...USER_PREF_PROCESSES, ...SAVED_VIEW_PROCESSES, ...IMPORT_PROCESSES, ...EXPORT_PROCESSES, ...HELP_PROCESSES, ...DATA_PROCESSES, ...HOME_PROCESSES, ...ADMIN_PROCESSES, ...AUDIT_PROCESSES],
  features: [
    {
      id: "kernel.attachments",
      label: "feature.kernel.attachments",
      processes: ATTACHMENT_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: "kernel.ai",
      label: "feature.kernel.ai",
      processes: AI_PROCESSES.map((p) => p.id),
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
    {
      id: "kernel.imports",
      label: "feature.kernel.imports",
      processes: IMPORT_PROCESSES.map((p) => p.id),
      entities: [importEntity.id],
    },
    {
      id: "kernel.exports",
      label: "feature.kernel.exports",
      processes: EXPORT_PROCESSES.map((p) => p.id),
      entities: [exportJobEntity.id],
    },
    {
      id: "kernel.help",
      label: "feature.kernel.help",
      processes: HELP_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: "kernel.data",
      label: "feature.kernel.data",
      processes: DATA_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: HOME_FEATURE,
      label: "feature.kernel.home",
      processes: HOME_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: ADMIN_FEATURE,
      label: "feature.kernel.admin",
      processes: ADMIN_PROCESSES.map((p) => p.id),
      entities: [],
    },
    {
      id: AUDIT_FEATURE,
      label: "feature.kernel.audit",
      processes: AUDIT_PROCESSES.map((p) => p.id),
      entities: [auditEntity.id],
    },
  ],
  events: { emits: [], consumes: {} },
  navigation: ADMIN_NAVIGATION,
  homeKpis: KERNEL_KPI_PROVIDERS,
});
