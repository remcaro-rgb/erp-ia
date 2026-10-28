"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

/** The administration's sections (prototype v5 subnav), in the prototype's order; the AI usage report last. */
export const ADMIN_SECTIONS = [
  { href: "/admin/permissions", label: "common.admin.section.permissions" },
  { href: "/admin/roles", label: "nav.kernel.roles" },
  { href: "/admin/users", label: "nav.kernel.users" },
  { href: "/admin/fields", label: "nav.kernel.fields" },
  { href: "/admin/extra", label: "nav.kernel.extra" },
  { href: "/admin/required-files", label: "nav.kernel.required_files" },
  { href: "/admin/sensitive", label: "nav.kernel.sensitive" },
  { href: "/admin/verifiers", label: "nav.kernel.verifiers" },
  { href: "/admin/modules", label: "nav.kernel.modules" },
  { href: "/admin/companies", label: "nav.kernel.companies" },
  { href: "/admin/ai-usage", label: "nav.kernel.ai_usage" },
] as const;

export function AdminSections() {
  const t = useTranslations();
  const pathname = usePathname();
  return (
    <nav className="erp-admin__sections" aria-label={t("common.admin.sections")}>
      {ADMIN_SECTIONS.map((section) => (
        <Link key={section.href} href={section.href} aria-current={pathname === section.href ? "page" : undefined}>
          {t(section.label)}
        </Link>
      ))}
    </nav>
  );
}
