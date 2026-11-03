"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import type { MenuAccessData, MenuRule } from "@/lib/parametros/load";
import { StepUpDock, useAdminAction } from "../_components/use-admin-action";

/**
 * Acceso al menú (spec §9.2, prototype «menuacceso»): the menu of the company's modules as a tree, by the items' names only (never their
 * technical keys, owner 2026-11-02); per item, the roles and users that see it. Rules only narrow: an allowed rule never shows an item the
 * role cannot open, and no rule applies to a company admin. Guardar replaces the item's rules (kernel.menu_access.set, step-up, audited).
 */
export function MenuAccessScreen({ data }: { data: MenuAccessData }) {
  const t = useTranslations();
  const base = useId();
  const { perform, prompt, status, busy, reset } = useAdminAction();
  const firstItem = data.nodes.find((n) => n.depth > 0)?.key ?? null;
  const [selected, setSelected] = useState<string | null>(firstItem);
  const [draft, setDraft] = useState<MenuRule[]>(selected ? (data.rules[selected] ?? []) : []);
  const [adding, setAdding] = useState("");
  const [shown, setShown] = useState(data);
  if (shown !== data) {
    setShown(data);
    setDraft(selected ? (data.rules[selected] ?? []) : []);
  }
  const stored = selected ? (data.rules[selected] ?? []) : [];
  const dirty = JSON.stringify(draft) !== JSON.stringify(stored);
  const node = data.nodes.find((n) => n.key === selected);
  const roleName = (id: string | null) => data.roles.find((r) => r.id === id)?.name ?? "—";
  const userName = (id: string | null) => data.members.find((m) => m.userId === id)?.name ?? "—";
  const candidates = [
    ...data.roles.filter((r) => !draft.some((x) => x.roleId === r.id)).map((r) => ({ value: `role:${r.id}`, label: t("common.parametros.menu.role_option", { name: r.name }) })),
    ...data.members.filter((m) => !draft.some((x) => x.userId === m.userId)).map((m) => ({ value: `user:${m.userId}`, label: t("common.parametros.menu.user_option", { name: m.name }) })),
  ];

  const pick = (key: string) => {
    reset();
    setSelected(key);
    setDraft(data.rules[key] ?? []);
  };
  const add = () => {
    const [kind, id] = adding.split(":");
    if (!id) return;
    setDraft((d) => [...d, { roleId: kind === "role" ? id : null, userId: kind === "user" ? id : null, allowed: true }]);
    setAdding("");
  };
  const save = () =>
    selected &&
    void perform("kernel.menu_access.set", {
      navKey: selected,
      rules: draft.map((r) => ({ ...(r.roleId ? { roleId: r.roleId } : {}), ...(r.userId ? { userId: r.userId } : {}), allowed: r.allowed })),
    });

  return (
    <div className="erp-stack erp-param">
      <div className="erp-row">
        <h2>{t("nav.kernel.menu_access")}</h2>
        <span className="erp-pill erp-pill--info">{t("common.parametros.menu.where")}</span>
      </div>
      <div className="erp-dian erp-dian--info">
        <b>{t("common.parametros.menu.narrow_title")}</b> {t("common.parametros.menu.narrow_body")}
      </div>
      <div className="erp-tpl erp-tpl--menu">
        <nav className="erp-card erp-param__tree" aria-label={t("common.parametros.menu.tree")}>
          {data.nodes.map((n) =>
            n.depth === 0 ? (
              <div key={n.key} className="erp-param__node is-module">
                {t(n.label)}
              </div>
            ) : (
              <button
                key={n.key}
                type="button"
                className={`erp-param__node${n.key === selected ? " is-on" : ""}`}
                style={{ paddingLeft: 8 + n.depth * 18, fontWeight: n.depth === 1 ? 700 : 400 }}
                aria-current={n.key === selected ? "true" : undefined}
                onClick={() => pick(n.key)}
              >
                <span className="erp-grow">{t(n.label)}</span>
                {(data.rules[n.key]?.length ?? 0) > 0 && <span className="erp-pill erp-pill--warn">{t("common.parametros.menu.rule_count", { count: data.rules[n.key]!.length })}</span>}
              </button>
            ),
          )}
        </nav>
        <section className="erp-card erp-stack" style={{ padding: 14 }}>
          {node ? (
            <>
              <h3>{t(node.label)}</h3>
              <table className="erp-param__table">
                <thead>
                  <tr>
                    <th>{t("common.parametros.type")}</th>
                    <th>{t("common.parametros.menu.who")}</th>
                    <th className="is-center">{t("common.parametros.menu.allowed")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {draft.length === 0 && (
                    <tr>
                      <td colSpan={4} className="erp-muted">
                        {t("common.parametros.menu.empty")}
                      </td>
                    </tr>
                  )}
                  {draft.map((r, i) => {
                    const who = r.roleId ? roleName(r.roleId) : userName(r.userId);
                    return (
                      <tr key={r.roleId ?? r.userId ?? i}>
                        <td>
                          <span className={`erp-pill ${r.roleId ? "erp-pill--info" : "erp-pill--gray"}`}>{r.roleId ? t("common.parametros.menu.role") : t("common.parametros.menu.user")}</span>
                        </td>
                        <td>{who}</td>
                        <td className="is-center">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={r.allowed}
                            aria-label={t("common.parametros.menu.allowed_for", { who })}
                            className={`erp-toggle${r.allowed ? " is-on" : ""}`}
                            disabled={busy}
                            onClick={() => setDraft((d) => d.map((x, j) => (j === i ? { ...x, allowed: !x.allowed } : x)))}
                          />
                        </td>
                        <td>
                          <button type="button" className="erp-btn erp-btn--sm erp-btn--ghost" disabled={busy} onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                            {t("common.parametros.menu.remove")}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="erp-row erp-row--wrap">
                <label htmlFor={`${base}-new`} className="erp-field__label">
                  {t("common.parametros.menu.new_rule")}
                </label>
                <select id={`${base}-new`} value={adding} onChange={(e) => setAdding(e.target.value)}>
                  <option value="">{t("common.parametros.menu.choose")}</option>
                  {candidates.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <button type="button" className="erp-btn" disabled={busy || !adding} onClick={add}>
                  {t("common.parametros.menu.add")}
                </button>
                <span className="erp-grow" />
                <button type="button" className="erp-btn erp-btn--primary" disabled={busy || !dirty} onClick={save}>
                  {t("common.parametros.save")}
                </button>
              </div>
              <span className="erp-small erp-muted">{t("common.parametros.menu.inherit")}</span>
              {status}
            </>
          ) : (
            <span className="erp-muted">{t("common.parametros.menu.none")}</span>
          )}
        </section>
      </div>
      <StepUpDock prompt={prompt} />
    </div>
  );
}
