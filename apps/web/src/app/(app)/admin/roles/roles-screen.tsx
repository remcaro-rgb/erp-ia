"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { RolesData } from "@/lib/admin/load";
import { AdminDialog } from "../_components/admin-dialog";
import { useAdminAction } from "../_components/use-admin-action";

const SCOPES = ["ambos", "clientes", "proveedores", "ninguno"] as const;

type Role = RolesData["roles"][number];

/** Roles (design §6): created by the admin with a description and the parties they see; users assigned from the role's side. */
export function RolesScreen({ data }: { data: RolesData }) {
  const t = useTranslations();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Role | null>(null);
  const holders = (roleId: string) => data.members.filter((m) => m.roleIds.includes(roleId));
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.roles.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.roles.hint")}</span>
        <span className="erp-grow" />
        <button type="button" className="erp-btn erp-btn--primary" onClick={() => setCreating(true)}>
          {t("common.admin.roles.new")}
        </button>
      </div>
      <div className="erp-admin__scroll">
        <table>
          <thead>
            <tr>
              <th>{t("common.admin.roles.col_name")}</th>
              <th>{t("common.admin.roles.col_description")}</th>
              <th>{t("common.admin.roles.col_scope")}</th>
              <th className="erp-num">{t("common.admin.roles.col_permissions")}</th>
              <th>{t("common.admin.roles.col_users")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.roles.map((role) => (
              <tr key={role.id}>
                <td>
                  <b>{role.name}</b> {role.isSystemAdmin && <span className="erp-pill erp-pill--gray">{t("common.admin.roles.system")}</span>}
                </td>
                <td style={{ whiteSpace: "normal" }}>{role.description}</td>
                <td>{t(`common.admin.scope.${role.partyScope}`)}</td>
                <td className="erp-num">{role.permissions}</td>
                <td style={{ whiteSpace: "normal" }}>
                  {holders(role.id).length === 0 ? (
                    <span className="erp-muted">{t("common.admin.roles.no_users")}</span>
                  ) : (
                    holders(role.id).map((m) => (
                      <span key={m.userId} className="erp-pill erp-pill--info">
                        {m.name}
                      </span>
                    ))
                  )}
                </td>
                <td>
                  <button type="button" className="erp-btn erp-btn--sm" onClick={() => setEditing(role)}>
                    {t("common.admin.roles.edit")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && <RoleDialog data={data} onClose={() => setCreating(false)} />}
      {editing && <RoleDialog key={editing.id} data={data} role={editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

/** "Nuevo rol" (kernel.admin.role.create) or "Rol · <name>": its data (kernel.admin.role.update) and its users (kernel.admin.user_role.set). */
function RoleDialog({ data, role, onClose }: { data: RolesData; role?: Role; onClose: () => void }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy } = useAdminAction();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [scope, setScope] = useState<string>(role?.partyScope ?? "ambos");
  const initialUsers = role ? data.members.filter((m) => m.roleIds.includes(role.id)).map((m) => m.userId) : [];
  const [users, setUsers] = useState<string[]>(initialUsers);

  const save = async () => {
    if (!role) {
      if (await perform("kernel.admin.role.create", { name, description, partyScope: scope })) onClose();
      return;
    }
    const changed = name !== role.name || description !== role.description || scope !== role.partyScope;
    if (changed && !(await perform("kernel.admin.role.update", { roleId: role.id, name, description, partyScope: scope }))) return;
    const sameUsers = users.length === initialUsers.length && users.every((u) => initialUsers.includes(u));
    if (!sameUsers && !(await perform("kernel.admin.user_role.set", { roleId: role.id, userIds: users }))) return;
    onClose();
  };

  return (
    <AdminDialog
      open
      title={role ? t("common.admin.roles.edit_title", { name: role.name }) : t("common.admin.roles.new")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="erp-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || name.trim() === ""} onClick={() => void save()}>
            {role ? t("common.admin.roles.save") : t("common.admin.roles.create")}
          </button>
        </>
      }
    >
      <div className="erp-form2">
        <div className="erp-field">
          <label htmlFor={`${base}-name`}>{t("common.admin.roles.name")}</label>
          <input id={`${base}-name`} value={name} maxLength={60} disabled={role?.isSystemAdmin} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="erp-field">
          <label htmlFor={`${base}-scope`}>{t("common.admin.roles.scope")}</label>
          <select id={`${base}-scope`} value={scope} disabled={role?.isSystemAdmin} onChange={(e) => setScope(e.target.value)}>
            {SCOPES.map((value) => (
              <option key={value} value={value}>
                {t(`common.admin.scope.${value}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="erp-field">
        <label htmlFor={`${base}-description`}>{t("common.admin.roles.description")}</label>
        <input id={`${base}-description`} value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
      </div>
      {role && (
        <fieldset className="erp-field">
          <legend className="erp-field__label">{t("common.admin.roles.users")}</legend>
          <div className="erp-checks">
            {data.members.map((member) => (
              <label key={member.userId} className="erp-check">
                <input
                  type="checkbox"
                  checked={users.includes(member.userId)}
                  onChange={(e) => setUsers((current) => (e.target.checked ? [...current, member.userId] : current.filter((id) => id !== member.userId)))}
                />{" "}
                {member.name} <span className="erp-small erp-muted">{member.email}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {!role && <div className="erp-small erp-muted">{t("common.admin.roles.create_hint")}</div>}
      <div className="erp-small erp-muted">
        {t("common.admin.process", { process: role ? "kernel.admin.role.update · kernel.admin.user_role.set" : "kernel.admin.role.create" })}
      </div>
      {status}
      {prompt}
    </AdminDialog>
  );
}
