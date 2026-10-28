"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { DEFAULT_PHONE_CC } from "@erp/kernel/validation";
import { EmailField, emailProblem, formatPhone, PhoneField, phoneProblem } from "@erp/ui";
import type { AdminMember, UsersData } from "@/lib/admin/load";
import { AdminDialog } from "../_components/admin-dialog";
import { useAdminAction } from "../_components/use-admin-action";

/** Photos travel as data URLs: at most 300 KB of picture. */
const MAX_PHOTO_BYTES = 300 * 1024;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]!)
    .join("")
    .slice(0, 2)
    .toUpperCase();

function Avatar({ name, photo, large }: { name: string; photo: string | null; large?: boolean }) {
  return (
    <span className={`erp-avatar${large ? " erp-avatar--lg" : ""}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL the admin chose, not an optimisable asset */}
      {photo ? <img src={photo} alt="" /> : initials(name) || "?"}
    </span>
  );
}

/** Usuarios (design §6): name, e-mail, mobile, roles and 2FA state; new users are invited; roles are edited from the user's side. */
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
              <th />
            </tr>
          </thead>
          <tbody>
            {data.members.map((member) => (
              <tr key={member.userId}>
                <td>
                  <Avatar name={member.name} photo={member.photo} />
                </td>
                <td>{member.name}</td>
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
                  <span className={`erp-pill erp-pill--${member.mfaEnrolled ? "ok" : "warn"}`}>{member.mfaEnrolled ? t("common.admin.users.mfa_on") : t("common.admin.users.mfa_off")}</span>
                </td>
                <td>
                  <button type="button" className="erp-btn erp-btn--sm" onClick={() => setEditing(member)}>
                    {t("common.admin.users.edit_roles")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <NewUserDialog data={data} onClose={() => setCreating(false)} />}
      {editing && <UserRolesDialog key={editing.userId} data={data} member={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function RoleChecks({ data, value, onChange }: { data: UsersData; value: string[]; onChange: (ids: string[]) => void }) {
  const t = useTranslations();
  return (
    <fieldset className="erp-field">
      <legend className="erp-field__label">
        {t("common.admin.users.roles")} <span className="erp-field__hint">{t("common.admin.users.roles_hint")}</span>
      </legend>
      <div className="erp-checks">
        {data.roles.map((role) => (
          <label key={role.id} className="erp-check">
            <input type="checkbox" checked={value.includes(role.id)} onChange={(e) => onChange(e.target.checked ? [...value, role.id] : value.filter((id) => id !== role.id))} />{" "}
            {role.name} <span className="erp-small erp-muted">{t(`common.admin.scope.${role.partyScope}`)}</span>
          </label>
        ))}
      </div>
      {value.length === 0 && <span className="erp-field__error">{t("common.admin.users.roles_required")}</span>}
    </fieldset>
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
  const [photoProblem, setPhotoProblem] = useState<string | null>(null);
  const ready = name.trim() !== "" && email !== "" && !emailProblem(email) && phone.number !== "" && !phoneProblem(phone.cc, phone.number) && roleIds.length > 0;

  const pickPhoto = (file: File | undefined) => {
    setPhotoProblem(null);
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) return setPhotoProblem(t("common.admin.users.photo_too_big"));
    const reader = new FileReader();
    reader.onload = () => setPhoto(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };
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
        <div className="erp-stack" style={{ alignItems: "center" }}>
          <Avatar name={name} photo={photo} large />
          <label className="erp-btn erp-btn--sm">
            {t("common.admin.users.photo")}
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pickPhoto(e.target.files?.[0])} />
          </label>
          {photo ? (
            <button type="button" className="erp-link erp-small" onClick={() => setPhoto(null)}>
              {t("common.admin.users.photo_remove")}
            </button>
          ) : (
            <span className="erp-hint erp-small erp-muted">{t("common.admin.users.photo_hint")}</span>
          )}
          {photoProblem && <span className="erp-field__error">{photoProblem}</span>}
        </div>
        <div className="erp-grow erp-stack">
          <div className="erp-form2">
            <div className="erp-field">
              <label htmlFor={`${base}-name`}>{t("common.admin.users.name")}</label>
              <input id={`${base}-name`} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </div>
            <EmailField label={t("common.admin.users.email")} value={email} onChange={setEmail} required />
            <PhoneField label={t("common.admin.users.mobile")} hint={t("common.admin.users.mobile_hint")} cc={phone.cc} number={phone.number} onChange={setPhone} />
          </div>
          <RoleChecks data={data} value={roleIds} onChange={setRoleIds} />
        </div>
      </div>
      <div className="erp-small erp-muted">{t("common.admin.users.create_hint")}</div>
      {status}
      {prompt}
    </AdminDialog>
  );
}

/** "Usuario · <name>": the user's roles (kernel.admin.user_role.set from the user's side). */
function UserRolesDialog({ data, member, onClose }: { data: UsersData; member: AdminMember; onClose: () => void }) {
  const t = useTranslations();
  const { perform, prompt, status, busy } = useAdminAction();
  const [roleIds, setRoleIds] = useState<string[]>(member.roleIds);
  const save = async () => {
    if (await perform("kernel.admin.user_role.set", { userId: member.userId, roleIds })) onClose();
  };
  return (
    <AdminDialog
      open
      title={t("common.admin.users.edit_title", { name: member.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || roleIds.length === 0} onClick={() => void save()}>
            {t("common.admin.users.save")}
          </button>
        </>
      }
    >
      <RoleChecks data={data} value={roleIds} onChange={setRoleIds} />
      <div className="erp-small erp-muted">{t("common.admin.users.edit_hint")}</div>
      {status}
      {prompt}
    </AdminDialog>
  );
}
