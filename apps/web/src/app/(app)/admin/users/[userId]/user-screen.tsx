"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { DEFAULT_PHONE_CC } from "@erp/kernel/validation";
import { formatPhone, useTabs } from "@erp/ui";
import type { UserPageData } from "@/lib/admin/load";
import { localeLabel } from "../user-changes";
import { Avatar, UserEditDialog, UserStateDialog } from "../user-dialogs";

/**
 * A user's page (design §22.16, rule 21: every reference to a user opens it): their data, roles, two-step verification and
 * last activity, with "Editar" (kernel.admin.user.update) and "Desactivar" / "Reactivar" (the same process, `active`).
 * The admin's own page offers no "Desactivar": an admin never deactivates themselves.
 */
export function UserScreen({ data }: { data: UserPageData }) {
  const t = useTranslations();
  const format = useFormatter();
  const titleId = useId();
  const [dialog, setDialog] = useState<"edit" | "state" | null>(null);
  const { member } = data;
  // The open tab is titled with the person's name, not the page's path (runs before the shell's own effect, children first).
  const pathname = usePathname();
  const openTab = useTabs((s) => s.open);
  const renameTab = useTabs((s) => s.rename);
  useEffect(() => {
    openTab({ title: member.name, href: pathname, kind: "grid" });
    renameTab(pathname, member.name);
  }, [openTab, renameTab, pathname, member.name]);
  const roles = data.roles.filter((role) => member.roleIds.includes(role.id));
  const locale = localeLabel(member.locale);
  return (
    <section className="erp-card erp-user" aria-labelledby={titleId}>
      <div className="erp-admin__head">
        <Link className="erp-link erp-small" href="/admin/users">
          {t("common.admin.users.page.back")}
        </Link>
        <span className="erp-muted" aria-hidden>
          ›
        </span>
        <Avatar name={member.name} photo={member.photo} large />
        <h2 id={titleId}>{member.name}</h2>
        <span className={`erp-pill erp-pill--${member.isActive ? "ok" : "gray"}`}>{member.isActive ? t("common.admin.users.active") : t("common.admin.users.inactive")}</span>
        <span className="erp-grow" />
        <button type="button" className="erp-btn" onClick={() => setDialog("edit")}>
          {t("common.admin.users.edit")}
        </button>
        {member.isActive ? (
          <button
            type="button"
            className="erp-btn erp-btn--danger"
            disabled={data.self}
            title={data.self ? t("common.admin.users.deactivate_self") : undefined}
            onClick={() => setDialog("state")}
          >
            {t("common.admin.users.deactivate")}
          </button>
        ) : (
          <button type="button" className="erp-btn erp-btn--primary" onClick={() => setDialog("state")}>
            {t("common.admin.users.reactivate")}
          </button>
        )}
      </div>
      <div className="erp-user__body">
        <div>
          <h3>{t("common.admin.users.page.data")}</h3>
          <dl className="erp-facts">
            <dt>{t("common.admin.users.name")}</dt>
            <dd>{member.name}</dd>
            <dt>{t("common.admin.users.email")}</dt>
            <dd className="erp-mono">{member.email}</dd>
            <dt>{t("common.admin.users.mobile")}</dt>
            <dd className="erp-mono">{member.mobile ? formatPhone(member.mobileCc ?? DEFAULT_PHONE_CC, member.mobile) : t("common.none")}</dd>
            <dt>{t("common.admin.users.locale")}</dt>
            <dd>{locale ? t(locale) : member.locale}</dd>
          </dl>
        </div>
        <div>
          <h3>{t("common.admin.users.page.access")}</h3>
          <dl className="erp-facts">
            <dt>{t("common.admin.users.roles")}</dt>
            <dd>
              {roles.length === 0
                ? t("common.none")
                : roles.map((role) => (
                    <span key={role.id} className="erp-pill erp-pill--info">
                      <Link className="erp-link erp-link--inline" href="/admin/roles">
                        {role.name}
                      </Link>
                    </span>
                  ))}
            </dd>
            <dt>{t("common.admin.users.page.mfa")}</dt>
            <dd>
              <span className={`erp-pill erp-pill--${member.mfaEnrolled ? "ok" : "warn"}`}>{member.mfaEnrolled ? t("common.admin.users.page.mfa_on") : t("common.admin.users.page.mfa_off")}</span>
            </dd>
            <dt>{t("common.admin.users.col_state")}</dt>
            <dd>{member.isActive ? t("common.admin.users.active") : t("common.admin.users.inactive")}</dd>
            <dt>{t("common.admin.users.page.last_activity")}</dt>
            <dd>{data.lastActivity ? format.dateTime(new Date(data.lastActivity), { dateStyle: "medium", timeStyle: "short" }) : t("common.admin.users.page.no_activity")}</dd>
          </dl>
        </div>
      </div>
      {dialog === "edit" && <UserEditDialog roles={data.roles} member={member} onClose={() => setDialog(null)} />}
      {dialog === "state" && <UserStateDialog member={member} onClose={() => setDialog(null)} />}
    </section>
  );
}
