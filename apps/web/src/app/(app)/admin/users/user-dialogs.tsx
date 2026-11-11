"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { PhoneField, phoneProblem } from "@erp/ui";
import type { AdminMember, AdminRole } from "@/lib/admin/load";
import { resetUserPasswordAction, setUserMfaAction } from "@/lib/auth/mfa-actions";
import { AdminDialog } from "../_components/admin-dialog";
import { useAdminAction } from "../_components/use-admin-action";
import { draftOf, USER_LOCALES, userChanges, type UserDraft } from "./user-changes";

// The pieces the users list and a user's page share (design §6, §22.16): the avatar, the role checks, the photo picker,
// "Editar" (kernel.admin.user.update: name, mobile, photo, locale and roles, with the step-up) and the confirmation of
// "Desactivar" / "Reactivar" (the same process with `active`), and of "Quitar segundo paso" (kernel.admin.user.mfa.set
// with `reset`, design §22.19).

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

export function Avatar({ name, photo, large }: { name: string; photo: string | null; large?: boolean }) {
  return (
    <span className={`erp-avatar${large ? " erp-avatar--lg" : ""}`} aria-hidden>
      {/* eslint-disable-next-line @next/next/no-img-element -- a data URL the admin chose, not an optimisable asset */}
      {photo ? <img src={photo} alt="" /> : initials(name) || "?"}
    </span>
  );
}

export function RoleChecks({ roles, value, onChange }: { roles: AdminRole[]; value: string[]; onChange: (ids: string[]) => void }) {
  const t = useTranslations();
  return (
    <fieldset className="erp-field">
      <legend className="erp-field__label">
        {t("common.admin.users.roles")} <span className="erp-field__hint">{t("common.admin.users.roles_hint")}</span>
      </legend>
      <div className="erp-checks">
        {roles.map((role) => (
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

/** The avatar with "Foto" (choose a PNG, JPEG or WebP up to 300 KB) and "Quitar la foto". */
export function PhotoPicker({ name, photo, onChange }: { name: string; photo: string | null; onChange: (photo: string | null) => void }) {
  const t = useTranslations();
  const [problem, setProblem] = useState<string | null>(null);
  const pick = (file: File | undefined) => {
    setProblem(null);
    if (!file) return;
    if (file.size > MAX_PHOTO_BYTES) return setProblem(t("common.admin.users.photo_too_big"));
    const reader = new FileReader();
    reader.onload = () => onChange(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };
  return (
    <div className="erp-stack" style={{ alignItems: "center" }}>
      <Avatar name={name} photo={photo} large />
      <label className="erp-btn erp-btn--sm">
        {t("common.admin.users.photo")}
        <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {photo ? (
        <button type="button" className="erp-link erp-small" onClick={() => onChange(null)}>
          {t("common.admin.users.photo_remove")}
        </button>
      ) : (
        <span className="erp-hint erp-small erp-muted">{t("common.admin.users.photo_hint")}</span>
      )}
      {problem && <span className="erp-field__error">{problem}</span>}
    </div>
  );
}

/** "Usuario · <name>": the member's data and roles (kernel.admin.user.update sends only what changed). */
export function UserEditDialog({ roles, member, onClose }: { roles: AdminRole[]; member: AdminMember; onClose: () => void }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy } = useAdminAction();
  const [draft, setDraft] = useState<UserDraft>(() => draftOf(member));
  const set = (patch: Partial<UserDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const changes = userChanges(member, draft);
  const start = draftOf(member);
  const mobileChanged = draft.mobile !== start.mobile || draft.mobileCc !== start.mobileCc;
  const ready = changes !== null && draft.name.trim() !== "" && (!mobileChanged || (draft.mobile !== "" && !phoneProblem(draft.mobileCc, draft.mobile))) && draft.roleIds.length > 0;
  const save = async () => {
    if (changes && (await perform("kernel.admin.user.update", changes))) onClose();
  };

  return (
    <AdminDialog
      open
      wide
      title={t("common.admin.users.edit_title", { name: member.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || !ready} title={changes === null ? t("common.admin.users.nothing_changed") : undefined} onClick={() => void save()}>
            {t("common.admin.users.save")}
          </button>
        </>
      }
    >
      <div className="erp-row erp-row--top" style={{ gap: 16 }}>
        <PhotoPicker name={draft.name} photo={draft.photo} onChange={(photo) => set({ photo })} />
        <div className="erp-grow erp-stack">
          <div className="erp-form2">
            <div className="erp-field">
              <label htmlFor={`${base}-name`}>{t("common.admin.users.name")}</label>
              <input id={`${base}-name`} value={draft.name} maxLength={120} onChange={(e) => set({ name: e.target.value })} />
              {draft.name.trim() === "" && <span className="erp-field__error">{t("common.admin.users.name_required")}</span>}
            </div>
            <div className="erp-field">
              <label htmlFor={`${base}-email`}>{t("common.admin.users.email")}</label>
              <input id={`${base}-email`} value={member.email} readOnly className="erp-mono" />
            </div>
            <PhoneField label={t("common.admin.users.mobile")} hint={t("common.admin.users.mobile_hint")} cc={draft.mobileCc} number={draft.mobile} onChange={(phone) => set({ mobileCc: phone.cc, mobile: phone.number })} />
            <div className="erp-field">
              <label htmlFor={`${base}-locale`}>{t("common.admin.users.locale")}</label>
              <select id={`${base}-locale`} value={draft.locale} onChange={(e) => set({ locale: e.target.value })}>
                {USER_LOCALES.map((locale) => (
                  <option key={locale.value} value={locale.value}>
                    {t(locale.label)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <RoleChecks roles={roles} value={draft.roleIds} onChange={(roleIds) => set({ roleIds })} />
        </div>
      </div>
      <div className="erp-small erp-muted">{t("common.admin.users.edit_hint")}</div>
      {status}
      {prompt}
    </AdminDialog>
  );
}

/** "¿Desactivar a <name>?" / "¿Reactivar a <name>?": the state alone, nothing else of the user changes. */
export function UserStateDialog({ member, onClose }: { member: AdminMember; onClose: () => void }) {
  const t = useTranslations();
  const { perform, prompt, status, busy } = useAdminAction();
  const activate = !member.isActive;
  const run = async () => {
    if (await perform("kernel.admin.user.update", { userId: member.userId, active: activate })) onClose();
  };
  return (
    <AdminDialog
      open
      title={t(activate ? "common.admin.users.reactivate_title" : "common.admin.users.deactivate_title", { name: member.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className={`erp-btn ${activate ? "erp-btn--primary" : "erp-btn--danger"}`} disabled={busy} onClick={() => void run()}>
            {t(activate ? "common.admin.users.reactivate" : "common.admin.users.deactivate")}
          </button>
        </>
      }
    >
      <p className="erp-small">{t(activate ? "common.admin.users.reactivate_body" : "common.admin.users.deactivate_body", { name: member.name })}</p>
      {status}
      {prompt}
    </AdminDialog>
  );
}

/**
 * "Quitar segundo paso" (kernel.admin.user.mfa.set `{ reset: true }`, step-up): the member's TOTP factor is removed and Auth
 * ends their sessions; they sign in with their password, or enrol again when their role requires it. An admin removing
 * their own factor is signed out the same way (the action answers the sign-in page).
 */
export function MfaResetDialog({ member, onClose }: { member: AdminMember; onClose: () => void }) {
  const t = useTranslations();
  const { execute, prompt, status, busy } = useAdminAction();
  const run = async () => {
    const result = await execute((stepUpToken) => setUserMfaAction(member.userId, { reset: true }, stepUpToken));
    if (!result.ok) return;
    if (result.next) window.location.assign(result.next);
    else onClose();
  };
  return (
    <AdminDialog
      open
      title={t("common.admin.users.page.mfa_reset_title", { name: member.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--danger" disabled={busy} onClick={() => void run()}>
            {t("common.admin.users.page.mfa_reset")}
          </button>
        </>
      }
    >
      <p className="erp-small">{t("common.admin.users.page.mfa_reset_confirm", { name: member.name })}</p>
      {status}
      {prompt}
    </AdminDialog>
  );
}

/**
 * "Restablecer contraseña" (kernel.admin.user.password.reset, step-up): the admin types a new password twice; the member's
 * sessions end and they sign in with it. The admin resetting their own password is signed out (the action answers where).
 */
export function PasswordResetDialog({ member, onClose }: { member: AdminMember; onClose: () => void }) {
  const t = useTranslations();
  const { execute, prompt, status, busy } = useAdminAction();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const run = async () => {
    if (password !== again) {
      setProblem(t("common.admin.users.page.password_mismatch"));
      return;
    }
    setProblem(null);
    const result = await execute((stepUpToken) => resetUserPasswordAction(member.userId, password, stepUpToken));
    if (!result.ok) return;
    if (result.next) window.location.assign(result.next);
    else {
      setPassword("");
      setAgain("");
      setDone(true);
    }
  };
  return (
    <AdminDialog
      open
      title={t("common.admin.users.page.password_reset_title", { name: member.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {done ? t("common.close") : t("common.cancel")}
          </button>
          {!done && (
            <button type="button" className="erp-btn erp-btn--primary" disabled={busy || password.length === 0} onClick={() => void run()}>
              {t("common.admin.users.page.password_reset")}
            </button>
          )}
        </>
      }
    >
      <p className="erp-small">{t("common.admin.users.page.password_reset_confirm", { name: member.name })}</p>
      {!done && (
        <>
          <label className="erp-field">
            <span>{t("common.admin.users.page.password_new")}</span>
            <input type="password" autoComplete="new-password" minLength={8} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="erp-field">
            <span>{t("common.admin.users.page.password_confirm")}</span>
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          </label>
        </>
      )}
      {problem && <div role="alert" className="erp-dian erp-dian--bad">{problem}</div>}
      {done && <div role="status" className="erp-dian erp-dian--ok">{t("common.admin.users.page.password_done", { name: member.name })}</div>}
      {status}
      {prompt}
    </AdminDialog>
  );
}
