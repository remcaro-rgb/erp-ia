"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDay } from "@erp/ui";
import type { ChecklistItemView, ChecklistView } from "@/lib/invoicing/checklist-view";
import { useAction } from "../use-action";

// Lista de verificación DIAN (plan 2B Task 35, R35-11). The rows are local choices until «Marcar los seleccionados» sends them as ONE tick run
// (one verification code, one transaction); «Confirmar valores por defecto» is its own run and is enabled only with every row verified. The
// server's state comes back through router.refresh (useAction); the local choices are dropped when it changes.

export function ChecklistForm({ view, timeZone }: { view: ChecklistView; timeZone?: string | undefined }) {
  // Dates in the company's zone, as the other screens print them (AAAA/MM/DD).
  const day = (iso: string | null) => (iso ? formatDay(iso, timeZone) : "");
  const t = useTranslations("invoicing.dian_checklist");
  const f = useId();
  const tick = useAction("tick", (data) => (data.confirmationCleared === true ? t("saved_cleared") : t("saved")));
  const confirm = useAction("confirm", () => t("confirmed"));

  // The choices not yet sent: key → wanted state. Dropped when the server's ticks change (the page re-renders after a run).
  const signature = `${view.confirmed}|${view.groups.flatMap((g) => g.items.map((i) => (i.ticked ? "1" : "0"))).join("")}`;
  const [synced, setSynced] = useState(signature);
  const [draft, setDraft] = useState<Record<string, boolean>>({});
  if (synced !== signature) {
    setSynced(signature);
    setDraft({});
  }

  const items = view.groups.flatMap((g) => g.items);
  const wanted = (item: ChecklistItemView) => draft[item.key] ?? item.ticked;
  const changes = items.filter((item) => wanted(item) !== item.ticked);
  const unticks = changes.filter((item) => !wanted(item));
  const locked = (item: ChecklistItemView) => view.locksUnticking && item.ticked;
  const setMany = (list: ChecklistItemView[], value: boolean) =>
    setDraft((current) => {
      const next = { ...current };
      for (const item of list) if (!(locked(item) && !value)) next[item.key] = value;
      return next;
    });
  const { done, total } = view.progress;
  const busy = tick.busy || confirm.busy;
  const send = () => void tick.run({ items: changes.map((item) => ({ itemKey: item.key, ticked: wanted(item) })) });

  return (
    <div className="erp-form mx-auto w-full max-w-4xl">
      <div>
        <Link className="erp-link erp-small" href="/invoicing/settings">{t("back")}</Link>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="erp-small erp-muted">{t("subtitle")}</p>
      </div>

      {view.newItems.length > 0 && !view.confirmed && (
        <div role="alert" className="erp-dian erp-dian--bad" data-testid="new-items">
          <b>{t("alert_new", { count: view.newItems.length })}</b>
          <p>{t("alert_new_hint")}</p>
          <ul>
            {view.newItems.map((item) => <li key={item.key}>{item.text}</li>)}
          </ul>
        </div>
      )}

      <section className="erp-sec" aria-label={t("progress_label")}>
        <p data-testid="progress-text"><b>{t("progress", { done, total })}</b></p>
        <div role="progressbar" aria-label={t("progress_label")} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={t("progress", { done, total })} className="erp-progress">
          <div className="erp-progress__bar" style={{ width: total > 0 ? `${Math.round((done / total) * 100)}%` : "0%", height: 6, background: "var(--accent, currentColor)", borderRadius: 3 }} />
        </div>
      </section>

      {view.locksUnticking && <div role="note" className="erp-dian erp-dian--bad">{t("locked_in_production")}</div>}

      {view.groups.map((group) => {
        const all = group.items.every((item) => wanted(item));
        return (
          <section key={group.group} className="erp-sec" aria-labelledby={`${f}-${group.group}`}>
            <div className="erp-row">
              <h3 id={`${f}-${group.group}`} className="erp-grow">{t(`groups.${group.group}` as never)}</h3>
              <button
                type="button"
                className="erp-btn"
                disabled={busy}
                onClick={() => setMany(group.items, !all)}
              >
                {all ? t("group_clear", { group: t(`groups.${group.group}` as never) }) : t("group_select", { group: t(`groups.${group.group}` as never) })}
              </button>
            </div>
            <ul className="erp-field">
              {group.items.map((item) => (
                <li key={item.key}>
                  <label className="erp-row">
                    <input
                      type="checkbox"
                      checked={wanted(item)}
                      disabled={busy || locked(item)}
                      onChange={(e) => setDraft((current) => ({ ...current, [item.key]: e.target.checked }))}
                    />
                    <span>
                      {item.text}
                      {item.isNew && <b className="erp-small"> · {t("new_badge")}</b>}
                    </span>
                  </label>
                  {item.docUrl && (
                    <a className="erp-link erp-small" href={item.docUrl} target="_blank" rel="noopener noreferrer">{t("doc_link")}</a>
                  )}
                  {item.ticked && (
                    <p className="erp-small erp-muted">
                      {item.tickedBy ? t("verified_by", { name: item.tickedBy, date: day(item.tickedAt) }) : t("verified_on", { date: day(item.tickedAt) })}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {tick.feedback}
      <div className="erp-row">
        <span className="erp-small erp-muted">{changes.length > 0 ? t("pending_changes", { count: changes.length }) : ""}</span>
        <span className="erp-grow" />
        <button type="button" className="erp-btn erp-btn--primary" disabled={busy || changes.length === 0} onClick={send}>
          {unticks.length > 0 ? t("save_changes") : t("mark_selected")}
        </button>
      </div>

      <section className="erp-sec" aria-label={t("confirm_button")}>
        {view.confirmed ? (
          <div role="status" className="erp-dian erp-dian--ok" data-testid="confirmed">
            {view.confirmedAt ? (view.confirmedBy ? t("confirmed_on", { date: day(view.confirmedAt), name: view.confirmedBy }) : t("confirmed_on_unknown", { date: day(view.confirmedAt) })) : t("confirmed")}
          </div>
        ) : (
          <p className="erp-small erp-muted">{t("not_confirmed")}</p>
        )}
        {confirm.feedback}
        <div className="erp-row">
          <span className="erp-small erp-muted">{!view.canConfirm || changes.length > 0 ? (changes.length > 0 ? t("confirm_save_first") : view.confirmed ? "" : t("confirm_incomplete")) : ""}</span>
          <span className="erp-grow" />
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || !view.canConfirm || changes.length > 0} onClick={() => void confirm.run({ confirmed: true })}>
            {t("confirm_button")}
          </button>
        </div>
      </section>
    </div>
  );
}
