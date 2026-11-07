import type { NavItem } from "../registry/types";

// The administration screens (design §6, prototype v5 "Sistema": Administración, Auditoría and Uso de IA). Each shows to
// whoever may run its process (the company admin role holds them all); only the three entry points sit in the module bar,
// the other sections are reached from the administration's own section bar and from ⌘K.
export const ADMIN_NAVIGATION: NavItem[] = [
  { id: "kernel.admin", label: "nav.kernel.admin", href: "/admin/permissions", icon: "shield", process: "kernel.admin.permission.set" },
  { id: "kernel.audit", label: "nav.kernel.audit", href: "/admin/audit", icon: "history", process: "kernel.audit.consult" },
  { id: "kernel.ai_usage", label: "nav.kernel.ai_usage", href: "/admin/ai-usage", icon: "sparkles", process: "kernel.admin.ai_usage.consult" },
  { id: "kernel.admin_roles", label: "nav.kernel.roles", href: "/admin/roles", icon: "shield", process: "kernel.admin.role.create", menu: false },
  { id: "kernel.admin_users", label: "nav.kernel.users", href: "/admin/users", icon: "users", process: "kernel.admin.user.create", menu: false },
  { id: "kernel.admin_fields", label: "nav.kernel.fields", href: "/admin/fields", icon: "eye", process: "kernel.admin.field_permission.set", menu: false },
  { id: "kernel.admin_extra", label: "nav.kernel.extra", href: "/admin/extra", icon: "list", process: "kernel.custom_field.set", menu: false },
  { id: "kernel.admin_required_files", label: "nav.kernel.required_files", href: "/admin/required-files", icon: "file", process: "kernel.required_file.set", menu: false },
  { id: "kernel.admin_sensitive", label: "nav.kernel.sensitive", href: "/admin/sensitive", icon: "lock", process: "kernel.admin.sensitive_process.set", menu: false },
  { id: "kernel.admin_verifiers", label: "nav.kernel.verifiers", href: "/admin/verifiers", icon: "check", process: "kernel.verifier.set", menu: false },
  { id: "kernel.admin_modules", label: "nav.kernel.modules", href: "/admin/modules", icon: "grid", process: "kernel.admin.module.enable", menu: false },
  { id: "kernel.admin_menu_access", label: "nav.kernel.menu_access", href: "/admin/menu-access", icon: "lock", process: "kernel.menu_access.set", menu: false },
  { id: "kernel.admin_companies", label: "nav.kernel.companies", href: "/admin/companies", icon: "building", process: "kernel.admin.company.update", menu: false },
  { id: "kernel.admin_nested_runs", label: "nav.kernel.nested_runs", href: "/admin/nested-runs", icon: "workflow", process: "kernel.admin.nested_run.pair.set", menu: false },
  // The nested-run failure queue (plan 2B Task 32): outside /admin so a role granted the retry or the dismissal can open it; on the bar for whoever may run either.
  { id: "kernel.nested_failures", label: "nav.kernel.nested_failures", href: "/nested-failures", icon: "list", anyProcess: ["kernel.nested_failure.retry", "kernel.nested_failure.dismiss"] },
];
