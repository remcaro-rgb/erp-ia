"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { recordHref, USER_ENTITY } from "@erp/kernel/href";
import { DEFAULT_PHONE_CC } from "@erp/kernel/validation";
import { EmailField, emailProblem, formatPhone, PhoneField, phoneProblem } from "@erp/ui";
import type { AdminMember, UsersData } from "@/lib/admin/load";
import { AdminDialog } from "../_components/admin-dialog";
import { useAdminAction } from "../_components/use-admin-action";
import { Avatar, PhotoPicker, RoleChecks, UserEditDialog } from "./user-dialogs";

/**
 * Usuarios (design §6, §22.16): name (a link to the user's page), e-mail, mobile, roles, 2FA and state; new users are
 * invited; "Editar" changes a user's data and roles.
 */
export function UsersScreen({ data }: { data: UsersData }) {
  const t = useTranslations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AdminMember | null>(null);
  const roleName = (id: string) => data.roles.find((r) => r.id === id)?.name ?? id;
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.users.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.users.hint")}</span>
        <span className="erp-grow" />
        <button type="button" className="erp-btn erp-btn--primary" onClick={() => setCreating(true)}>
          {t("common.admin.users.new")}
        </button>
      </div>
      <div className="erp-admin__scroll">
        <table>
          <thead>
            <tr>
              <th />
              <th>{t("common.admin.users.col_name")}</th>
              <th>{t("common.admin.users.col_email")}</th>
              <th>{t("common.admin.users.col_mobile")}</th>
              <th>{t("common.admin.users.col_roles")}</th>
              <th>{t("common.admin.users.col_mfa")}</th>
              <th>{t("common.admin.users.col_state")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.members.map((member) => (
              <tr key={member.userId}>
                <td>
                  <Avatar name={member.name} photo={member.photo} />
                </td>
                <td>
                  <Link className="erp-link erp-link--inline" href={recordHref(USER_ENTITY, member.userId)}>
                    {member.name}
                  </Link>
                </td>
                <td className="erp-mono erp-small">{member.email}</td>
                <td className="erp-mono erp-small">{member.mobile ? formatPhone(member.mobileCc ?? DEFAULT_PHONE_CC, member.mobile) : t("common.none")}</td>
                <td>
                  {member.roleIds.map((id) => (
                    <span key={id} className="erp-pill erp-pill--info">
                      {roleName(id)}
                    </span>
                  ))}
                </td>
                <td>
                  {/* Exempt and without a factor (design §22.19): nothing is pending for them. */}
                  {member.mfaEnrolled ? (
                    <span className="erp-pill erp-pill--ok">{t("common.admin.users.mfa_on")}</span>
                  ) : member.mfaExempt ? (
                    <span className="erp-pill erp-pill--info">{t("common.admin.users.mfa_exempt")}</span>
                  ) : (
                    <span className="erp-pill erp-pill--warn">{t("common.admin.users.mfa_off")}</span>
                  )}
                </td>
                <td>
                  <span className={`erp-pill erp-pill--${member.isActive ? "ok" : "gray"}`}>{member.isActive ? t("common.admin.users.active") : t("common.admin.users.inactive")}</span>
                </td>
                <td>
                  <button type="button" className="erp-btn erp-btn--sm" onClick={() => setEditing(member)}>
                    {t("common.admin.users.edit")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <NewUserDialog data={data} onClose={() => setCreating(false)} />}
      {editing && <UserEditDialog key={editing.userId} roles={data.roles} member={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** "Nuevo usuario" (kernel.admin.user.create): at least e-mail, mobile and one role; photo optional; the invitation goes by e-mail. */
function NewUserDialog({ data, onClose }: { data: UsersData; onClose: () => void }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy } = useAdminAction();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState({ cc: DEFAULT_PHONE_CC, number: "" });
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  const ready = name.trim() !== "" && email !== "" && !emailProblem(email) && phone.number !== "" && !phoneProblem(phone.cc, phone.number) && roleIds.length > 0;

  const save = async () => {
    const input = { name, email, mobileCc: phone.cc, mobile: phone.number, roleIds, ...(photo ? { photo } : {}) };
    if (await perform("kernel.admin.user.create", input)) onClose();
  };

  return (
    <AdminDialog
      open
      wide
      title={t("common.admin.users.new")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || !ready} onClick={() => void save()}>
            {t("common.admin.users.create")}
          </button>
        </>
      }
    >
      <div className="erp-row erp-row--top" style={{ gap: 16 }}>
        <PhotoPicker name={name} photo={photo} onChange={setPhoto} />
        <div className="erp-grow erp-stack">
          <div className="erp-form2">
            <div className="erp-field">
              <label htmlFor={`${base}-name`}>{t("common.admin.users.name")}</label>
              <input id={`${base}-name`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </div>
            <EmailField label={t("common.admin.users.email")} value={email} onChange={setEmail} required />
            <PhoneField label={t("common.admin.users.mobile")} hint={t("common.admin.users.mobile_hint")} cc={phone.cc} number={phone.number} onChange={setPhone} />
          </div>
          <RoleChecks roles={data.roles} value={roleIds} onChange={setRoleIds} />
        </div>
      </div>
      <div className="erp-small erp-muted">{t("common.admin.users.create_hint")}</div>
      {status}
      {prompt}
    </AdminDialog>
  );
}
