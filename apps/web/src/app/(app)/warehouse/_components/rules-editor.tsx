"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { StepUpPrompt } from "@erp/ui";
import { useStepRunner } from "@/lib/records/use-step-runner";
import { saveRuleAction } from "@/lib/warehouse/actions";
import type { LocationOption, Option, RuleRow, RulesPageData } from "@/lib/warehouse/screens";
import { Failure, useFailureText } from "./failure";

// Parámetros › Reglas de ubicación (plan 2B.2 Task 29.4, PG §4.3 step 8): per bodega, where a category's goods (or any goods) go, the
// lowest priority first; each button runs one of warehouse.putaway_rule.create, .update, .delete (rule 1).

// -------------------------------------------------------------------------------------------------
// Reglas de ubicación
// -------------------------------------------------------------------------------------------------

interface RuleDraft {
  warehouseId: string;
  categoryId: string;
  locationId: string;
  priority: string;
}

const draftOf = (r: RuleRow): RuleDraft => ({ warehouseId: r.warehouseId, categoryId: r.categoryId ?? "", locationId: r.locationId, priority: String(r.priority) });
const priorityOf = (s: string) => (/^\d{1,4}$/.test(s.trim()) ? Number(s.trim()) : null);

function Select({ label, value, options, disabled, onChange, empty }: { label: string; value: string; options: readonly Option[]; disabled: boolean; onChange: (v: string) => void; empty?: string }) {
  return (
    <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {empty !== undefined && <option value="">{empty}</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function PutawayRulesEditor({ data }: { data: RulesPageData }) {
  const t = useTranslations("warehouse.rules_page");
  const failureText = useFailureText();
  const router = useRouter();
  const [drafts, setDrafts] = useState<Record<string, RuleDraft>>(() => Object.fromEntries(data.rules.map((r) => [r.id, draftOf(r)])));
  const rulesKey = data.rules.map((r) => `${r.id}:${r.categoryId}:${r.locationId}:${r.priority}`).join("|");
  const [seen, setSeen] = useState(rulesKey);
  if (seen !== rulesKey) {
    setSeen(rulesKey);
    setDrafts(Object.fromEntries(data.rules.map((r) => [r.id, draftOf(r)])));
  }
  const blank: RuleDraft = { warehouseId: data.warehouses[0]?.id ?? "", categoryId: "", locationId: "", priority: "10" };
  const [fresh, setFresh] = useState<RuleDraft>(blank);
  const step = useStepRunner(
    (op: "create" | "update" | "delete", input, token) => saveRuleAction(op, input, token),
    () => {
      setFresh((f) => ({ ...blank, warehouseId: f.warehouseId }));
      router.refresh();
    },
  );
  const warehouseName = (id: string) => data.warehouses.find((w) => w.id === id)?.label ?? "—";
  const locationsOf = (warehouseId: string): LocationOption[] => data.locations.filter((l) => l.warehouseId === warehouseId);
  const inputOf = (d: RuleDraft) => ({ warehouseId: d.warehouseId, categoryId: d.categoryId || null, locationId: d.locationId, priority: priorityOf(d.priority) });
  const editable = data.may.update && !step.busy;

  return (
    <div className="erp-form">
      <section className="erp-sec">
        <h3>{t("title")}</h3>
        <p className="erp-small erp-muted">{t("hint")}</p>
        <div className="erp-lines__scroll">
          <table className="erp-lines__table" aria-label={t("title")}>
            <thead>
              <tr>
                <th scope="col">{t("warehouse")}</th>
                <th scope="col">{t("category")}</th>
                <th scope="col">{t("location")}</th>
                <th scope="col" className="erp-num">
                  {t("priority")}
                </th>
                <th scope="col">
                  <span className="sr-only">{t("actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rules.length === 0 && (
                <tr>
                  <td colSpan={5} className="erp-muted">
                    {t("empty")}
                  </td>
                </tr>
              )}
              {data.rules.map((r, i) => {
                const d = drafts[r.id] ?? draftOf(r);
                const set = (patch: Partial<RuleDraft>) => setDrafts((all) => ({ ...all, [r.id]: { ...d, ...patch } }));
                const dirty = d.categoryId !== (r.categoryId ?? "") || d.locationId !== r.locationId || d.priority !== String(r.priority);
                return (
                  <tr key={r.id} data-testid={`rule-${i + 1}`}>
                    <td>{warehouseName(r.warehouseId)}</td>
                    <td>
                      <Select label={t("category_line", { n: i + 1 })} value={d.categoryId} options={data.categories} disabled={!editable} empty={t("any_goods")} onChange={(v) => set({ categoryId: v })} />
                    </td>
                    <td>
                      <Select label={t("location_line", { n: i + 1 })} value={d.locationId} options={locationsOf(r.warehouseId)} disabled={!editable} onChange={(v) => set({ locationId: v })} />
                    </td>
                    <td className="erp-num">
                      <input aria-label={t("priority_line", { n: i + 1 })} className="erp-num erp-mono" inputMode="numeric" maxLength={4} value={d.priority} disabled={!editable} onChange={(e) => set({ priority: e.target.value })} />
                    </td>
                    <td className="erp-row">
                      {data.may.update && (
                        <button type="button" className="erp-btn" disabled={step.busy || !dirty || priorityOf(d.priority) === null} onClick={() => step.run("update", { id: r.id, ...inputOf(d) })}>
                          {t("save")}
                        </button>
                      )}
                      {data.may.delete && (
                        <button type="button" className="erp-btn" disabled={step.busy} onClick={() => step.run("delete", { id: r.id })}>
                          {t("delete")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {data.may.create && (
        <section className="erp-sec">
          <h3>{t("new_rule")}</h3>
          <div className="erp-form2">
            <div className="erp-field">
              <span className="erp-field__label">{t("warehouse")}</span>
              <Select label={t("new_warehouse")} value={fresh.warehouseId} options={data.warehouses} disabled={step.busy} onChange={(v) => setFresh((f) => ({ ...f, warehouseId: v, locationId: "" }))} />
            </div>
            <div className="erp-field">
              <span className="erp-field__label">{t("category")}</span>
              <Select label={t("new_category")} value={fresh.categoryId} options={data.categories} disabled={step.busy} empty={t("any_goods")} onChange={(v) => setFresh((f) => ({ ...f, categoryId: v }))} />
            </div>
            <div className="erp-field">
              <span className="erp-field__label">{t("location")}</span>
              <Select label={t("new_location")} value={fresh.locationId} options={locationsOf(fresh.warehouseId)} disabled={step.busy} empty="—" onChange={(v) => setFresh((f) => ({ ...f, locationId: v }))} />
            </div>
            <div className="erp-field">
              <span className="erp-field__label">{t("priority")}</span>
              <input aria-label={t("new_priority")} className="erp-num erp-mono" inputMode="numeric" maxLength={4} value={fresh.priority} disabled={step.busy} onChange={(e) => setFresh((f) => ({ ...f, priority: e.target.value }))} />
            </div>
          </div>
          <div className="erp-row">
            <span className="erp-grow" />
            <button
              type="button"
              className="erp-btn erp-btn--primary"
              disabled={step.busy || !fresh.warehouseId || !fresh.locationId || priorityOf(fresh.priority) === null}
              onClick={() => step.run("create", inputOf(fresh))}
            >
              {t("add")}
            </button>
          </div>
        </section>
      )}
      <Failure text={failureText(step.failure)} />
      {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
    </div>
  );
}

