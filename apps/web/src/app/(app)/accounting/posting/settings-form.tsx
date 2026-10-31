"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { SettingsData } from "@/lib/accounting/posting";
import { saveSettingsAction, type SettingsEdit } from "@/lib/accounting/posting-actions";
import { useAdminAction } from "../../admin/_components/use-admin-action";

/** Configuración contable (accounting design §4.11): the settings of the ledger, saved under step-up, and the events that predate its start. */
export function SettingsForm({ settings, canEdit }: { settings: SettingsData; canEdit: boolean }) {
  const t = useTranslations("accounting.pages.posting");
  const { execute, prompt, status, busy } = useAdminAction();
  const [form, setForm] = useState<SettingsEdit>({
    useOpenAuxiliaries: settings.useOpenAuxiliaries,
    useItems: settings.useItems,
    useBusinessUnits: settings.useBusinessUnits,
    requireApprovalOnManual: settings.requireApprovalOnManual,
    requireAttachmentOnManual: settings.requireAttachmentOnManual,
    roundingTolerance: settings.roundingTolerance,
    manualJournalId: settings.manualJournalId ?? settings.journals[0]?.id ?? "",
    niifGroup: settings.niifGroup,
  });
  const set = <K extends keyof SettingsEdit>(key: K, value: SettingsEdit[K]) => setForm((f) => ({ ...f, [key]: value }));
  const check = (key: "useOpenAuxiliaries" | "useItems" | "useBusinessUnits" | "requireApprovalOnManual" | "requireAttachmentOnManual", label: string) => (
    <label className="erp-check" key={key}>
      <input type="checkbox" disabled={!canEdit} checked={form[key]} onChange={(e) => set(key, e.target.checked)} /> {label}
    </label>
  );

  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("tab.settings")}</h2>
        <span className="erp-grow" />
        {canEdit && (
          <button type="button" className="erp-btn erp-btn--primary" disabled={busy || form.manualJournalId === ""} onClick={() => void execute((token) => saveSettingsAction(form, token))}>
            {t("save")}
          </button>
        )}
      </div>
      <div className="erp-form2">
        <fieldset className="erp-field">
          <legend className="erp-field__label">{t("settings_dimensions")}</legend>
          {check("useOpenAuxiliaries", t("use_open_auxiliaries"))}
          {check("useItems", t("use_items"))}
          {check("useBusinessUnits", t("use_business_units"))}
        </fieldset>
        <fieldset className="erp-field">
          <legend className="erp-field__label">{t("settings_manual")}</legend>
          {check("requireApprovalOnManual", t("require_approval"))}
          {check("requireAttachmentOnManual", t("require_attachment"))}
        </fieldset>
        <div className="erp-field">
          <label htmlFor="set-journal">{t("manual_journal")}</label>
          <select id="set-journal" disabled={!canEdit} value={form.manualJournalId} onChange={(e) => set("manualJournalId", e.target.value)}>
            {settings.journals.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
        </div>
        <div className="erp-field">
          <label htmlFor="set-niif">{t("niif_group")}</label>
          <select id="set-niif" disabled={!canEdit} value={form.niifGroup} onChange={(e) => set("niifGroup", e.target.value as "1" | "2" | "3")}>
            {(["1", "2", "3"] as const).map((g) => (
              <option key={g} value={g}>
                {t(`niif_${g}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="erp-field">
          <label htmlFor="set-tolerance">{t("rounding_tolerance")}</label>
          <input id="set-tolerance" type="number" min={0} step="0.01" disabled={!canEdit} value={form.roundingTolerance} onChange={(e) => set("roundingTolerance", Number(e.target.value))} />
          <div className="erp-small erp-muted">{t("rounding_hint")}</div>
        </div>
      </div>
      <dl className="erp-kv" aria-label={t("ledger_facts")}>
        <dt>{t("ledger_starts_on")}</dt>
        <dd className="erp-mono">{settings.ledgerStartsOn ? settings.ledgerStartsOn.split("-").reverse().join("/") : "—"}</dd>
        <dt>{t("skipped_events")}</dt>
        <dd className="erp-mono" data-testid="skipped-events">
          {settings.skippedEvents}
        </dd>
      </dl>
      <p className="erp-small erp-muted">{t("skipped_hint")}</p>
      {status}
      {prompt}
    </section>
  );
}
