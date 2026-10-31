"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { AccountPick } from "../_components/account-pick";
import type { AccountLookup, MappingRow } from "@/lib/accounting/posting";
import { saveMappingsAction } from "@/lib/accounting/posting-actions";
import { useAdminAction } from "../../admin/_components/use-admin-action";

type Chosen = { id: string; label: string } | null;

const keyOf = (role: string, dimension: string | null) => `${role}|${dimension ?? ""}`;

/** Mapeo de cuentas: the account each posting role resolves to (by dimension too); the roles still without one come first. */
export function MappingTable({ rows, unmapped, lookup, canEdit }: { rows: MappingRow[]; unmapped: string[]; lookup: AccountLookup; canEdit: boolean }) {
  const t = useTranslations("accounting.pages.posting");
  const tr = useTranslations("common.record.contributed.roles");
  const { execute, prompt, status, busy } = useAdminAction();
  const all = useMemo<MappingRow[]>(() => [...unmapped.map((role) => ({ role, dimension: null, account: null })), ...rows], [rows, unmapped]);
  const baseline = useMemo(() => new Map(all.map((r) => [keyOf(r.role, r.dimension), r.account?.id ?? null])), [all]);
  const [picks, setPicks] = useState<Map<string, Chosen>>(new Map());
  const current = (r: MappingRow): Chosen => (picks.has(keyOf(r.role, r.dimension)) ? picks.get(keyOf(r.role, r.dimension))! : r.account);
  const edits = all.filter((r) => (current(r)?.id ?? null) !== baseline.get(keyOf(r.role, r.dimension)));
  const roleName = (role: string) => (tr.has(role) ? tr(role) : role);

  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("tab.mapping")}</h2>
        <span className="erp-small erp-muted">{unmapped.length === 0 ? t("mapping_complete") : t("mapping_missing", { count: unmapped.length })}</span>
        <span className="erp-grow" />
        {canEdit && (
          <button
            type="button"
            className="erp-btn erp-btn--primary"
            disabled={edits.length === 0 || busy}
            onClick={() =>
              void execute((token) => saveMappingsAction(edits.map((r) => ({ role: r.role, dimension: r.dimension, accountId: current(r)?.id ?? null })), token)).then((r) => r.ok && setPicks(new Map()))
            }
          >
            {t("save")}
          </button>
        )}
      </div>
      <div className="erp-admin__scroll">
        <table aria-label={t("tab.mapping")}>
          <thead>
            <tr>
              <th>{t("col_role")}</th>
              <th>{t("col_dimension")}</th>
              <th>{t("col_account")}</th>
            </tr>
          </thead>
          <tbody>
            {all.map((r) => {
              const k = keyOf(r.role, r.dimension);
              const missing = current(r) === null && r.dimension === null;
              return (
                <tr key={k} data-missing={missing}>
                  <td>
                    <b>{roleName(r.role)}</b> <span className="erp-small erp-muted erp-mono">{r.role}</span>
                  </td>
                  <td className="erp-mono">{r.dimension ?? "—"}</td>
                  <td>
                    <AccountPick
                      id={`map-${k}`}
                      label={t("account_of", { role: roleName(r.role) })}
                      lookup={lookup}
                      value={current(r)}
                      disabled={!canEdit}
                      placeholder={missing ? t("without_account") : undefined}
                      onPick={(account) => setPicks((m) => new Map(m).set(k, account))}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {status}
      {prompt}
    </section>
  );
}
