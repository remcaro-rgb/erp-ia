"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { formatMoney } from "@erp/ui";
import type { AccountLookup, ConceptsData } from "@/lib/accounting/posting";
import { saveConceptsAction, type ConceptEdit } from "@/lib/accounting/posting-actions";
import { AccountPick } from "../_components/account-pick";
import { useAdminAction } from "../../admin/_components/use-admin-action";

interface Added {
  concept: string;
  code: string;
  name: string;
}

/**
 * Conceptos exógena: for the chosen format of the year, the DIAN concepts with the accounts that feed them and the accounts with movement
 * no concept covers yet (the few the pack could not guess). Changes are staged and saved together under step-up.
 */
export function ConceptsPanel({ data, lookup, canEdit }: { data: ConceptsData; lookup: AccountLookup | null; canEdit: boolean }) {
  const t = useTranslations("accounting.pages.posting");
  const router = useRouter();
  const { execute, prompt, status, busy } = useAdminAction();
  const [added, setAdded] = useState<Map<string, Added>>(new Map());
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());

  const edits: ConceptEdit[] = [
    ...[...added].map(([accountId, a]) => ({ format: data.format, concept: a.concept, accountId, isActive: true })),
    ...data.concepts.flatMap((c) => c.accounts.filter((a) => toggled.has(a.id) && toggled.get(a.id) !== a.isActive).map((a) => ({ format: data.format, concept: c.code, accountId: a.id, isActive: toggled.get(a.id)! }))),
  ];
  const go = (format: string, year: number) => router.push(`/accounting/posting?tab=concepts&format=${encodeURIComponent(format)}&year=${year}`);

  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("tab.concepts")}</h2>
        <label className="erp-field erp-field--inline">
          <span className="erp-small">{t("format")}</span>
          <select value={data.format} onChange={(e) => go(e.target.value, data.year)}>
            {data.formats.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="erp-field erp-field--inline">
          <span className="erp-small">{t("year")}</span>
          <input type="number" min={2000} max={2100} defaultValue={data.year} onBlur={(e) => Number(e.target.value) !== data.year && go(data.format, Number(e.target.value))} />
        </label>
        <span className="erp-grow" />
        {canEdit && (
          <button
            type="button"
            className="erp-btn erp-btn--primary"
            disabled={edits.length === 0 || busy}
            onClick={() =>
              void execute((token) => saveConceptsAction(edits, token)).then((r) => {
                if (r.ok) {
                  setAdded(new Map());
                  setToggled(new Map());
                }
              })
            }
          >
            {t("save")}
          </button>
        )}
      </div>

      <h3 className="erp-origin__title">{t("unmapped_title", { count: data.unmapped.length })}</h3>
      {data.unmapped.length === 0 ? (
        <p className="erp-muted erp-small">{t("unmapped_none")}</p>
      ) : (
        <div className="erp-admin__scroll">
          <table aria-label={t("unmapped_title", { count: data.unmapped.length })}>
            <thead>
              <tr>
                <th>{t("col_account")}</th>
                <th className="erp-num">{t("col_movement")}</th>
                <th>{t("col_concept")}</th>
              </tr>
            </thead>
            <tbody>
              {data.unmapped.map((u) => (
                <tr key={u.accountId}>
                  <td>
                    <span className="erp-mono">{u.code}</span> {u.name}
                  </td>
                  <td className="erp-num erp-mono">{formatMoney(u.movement)}</td>
                  <td>
                    <select
                      aria-label={t("concept_of", { account: u.code })}
                      disabled={!canEdit}
                      value={added.get(u.accountId)?.concept ?? ""}
                      onChange={(e) =>
                        setAdded((m) => {
                          const next = new Map(m);
                          if (e.target.value === "") next.delete(u.accountId);
                          else next.set(u.accountId, { concept: e.target.value, code: u.code, name: u.name });
                          return next;
                        })
                      }
                    >
                      <option value="">{t("choose_concept")}</option>
                      {data.concepts.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code} · {c.label}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="erp-origin__title">{t("concepts_title")}</h3>
      <div className="erp-admin__scroll">
        <table aria-label={t("concepts_title")}>
          <thead>
            <tr>
              <th>{t("col_concept")}</th>
              <th>{t("col_accounts")}</th>
              <th>{t("add_account")}</th>
            </tr>
          </thead>
          <tbody>
            {data.concepts.map((c) => (
              <tr key={c.code}>
                <td style={{ whiteSpace: "normal" }}>
                  <b className="erp-mono">{c.code}</b> {c.label}
                </td>
                <td style={{ whiteSpace: "normal" }}>
                  {c.accounts.length === 0 && ![...added.values()].some((a) => a.concept === c.code) && <span className="erp-muted">—</span>}
                  {c.accounts.map((a) => (
                    <label key={a.id} className="erp-check" style={{ display: "block" }}>
                      <input
                        type="checkbox"
                        disabled={!canEdit}
                        checked={toggled.has(a.id) ? toggled.get(a.id)! : a.isActive}
                        onChange={(e) => setToggled((m) => new Map(m).set(a.id, e.target.checked))}
                        aria-label={t("active_account", { account: a.code })}
                      />{" "}
                      <span className="erp-mono">{a.code}</span> {a.name}
                    </label>
                  ))}
                  {[...added].filter(([, a]) => a.concept === c.code).map(([id, a]) => (
                    <div key={id} className="erp-small">
                      + <span className="erp-mono">{a.code}</span> {a.name}
                    </div>
                  ))}
                </td>
                <td>
                  {lookup && (
                    <AccountPick
                      id={`concept-${c.code}`}
                      label={t("add_account_to", { concept: c.code })}
                      lookup={lookup}
                      value={null}
                      disabled={!canEdit}
                      onPick={(account) => account && setAdded((m) => new Map(m).set(account.id, { concept: c.code, code: account.label.split(" — ")[0] ?? "", name: account.label.split(" — ")[1] ?? "" }))}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {status}
      {prompt}
    </section>
  );
}
