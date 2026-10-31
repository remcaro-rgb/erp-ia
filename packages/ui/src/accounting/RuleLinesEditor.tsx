"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { failureMessages } from "../forms/form-parts";
import type { RequestStepUp, SaveRecord } from "../forms/save-model";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import { useSaveFlow } from "../forms/use-save";
import { blankRuleLine, linesIncomplete, ruleLinesInput, RULE_COLUMNS, setLineField, type RuleLine } from "./rule-lines-model";
import { ProcessId } from "../forms/ProcessId";

// The Líneas tab of a Regla contable (accounting design §4.8, §8): the template's lines as a grid, one row per line with its role (or
// fixed account), side, the payload path of the amount and of each dimension, and the tax fields. Guardar is `posting_rule.update`,
// a step-up process: it asks for the code in place and marks the rule as modified by the company.

export interface RuleLinesEditorProps {
  ruleId: string;
  /** The stored template, whose other keys (description, date, source…) are kept as they are. */
  template: Readonly<Record<string, unknown>>;
  lines: readonly RuleLine[];
  /** The roles a line can name (the kernel catalogue and those the loaded modules add). */
  roles: readonly string[];
  canSave: boolean;
  save: SaveRecord;
  requestStepUp?: RequestStepUp;
  onSaved?: () => void;
}

export function RuleLinesEditor({ ruleId, template, lines: stored, roles, canSave, save, requestStepUp, onSaved }: RuleLinesEditorProps) {
  const t = useTranslations("accounting.record.rule");
  const te = useTranslations("errors");
  const key = JSON.stringify(stored);
  const [seen, setSeen] = useState(key);
  const [lines, setLines] = useState<RuleLine[]>([...stored]);
  if (seen !== key) {
    setSeen(key);
    setLines([...stored]);
  }
  const flow = useSaveFlow(save, requestStepUp, () => onSaved?.());
  const failed = failureMessages(flow.failure, [], (code) => (te.has(code) ? te(code) : te("unknown")));
  const dirty = JSON.stringify(lines) !== key;
  const incomplete = linesIncomplete(lines);
  const label = (column: string, row: number) => `${t(`col.${RULE_COLUMNS.find((c) => c.key === column)!.label}`)}, ${t("line_n", { n: row + 1 })}`;

  return (
    <div className="erp-lines">
      <div className="erp-lines__scroll">
        <table className="erp-lines__table" aria-label={t("lines_label")}>
          <thead>
            <tr>
              <th scope="col" className="erp-lines__no">
                #
              </th>
              {RULE_COLUMNS.map((c) => (
                <th key={c.key} scope="col">
                  {t(`col.${c.label}`)}
                </th>
              ))}
              <th scope="col" className="erp-lines__act" aria-label={t("remove_col")} />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, row) => (
              <tr key={row}>
                <td className="erp-lines__no erp-muted">{row + 1}</td>
                {RULE_COLUMNS.map((c) => (
                  <td key={c.key}>
                    {c.kind === "role" ? (
                      <select aria-label={label(c.key, row)} value={line.role ?? ""} disabled={!canSave} onChange={(e) => setLines((l) => setLineField(l, row, "role", e.target.value))}>
                        <option value="">—</option>
                        {line.role && !roles.includes(line.role) && <option value={line.role}>{line.role}</option>}
                        {roles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : c.kind === "side" ? (
                      <select aria-label={label(c.key, row)} value={line.side} disabled={!canSave} onChange={(e) => setLines((l) => setLineField(l, row, "side", e.target.value))}>
                        <option value="debit">{t("side.debit")}</option>
                        <option value="credit">{t("side.credit")}</option>
                      </select>
                    ) : (
                      <input
                        aria-label={label(c.key, row)}
                        className={c.mono ? "erp-mono" : undefined}
                        value={line[c.key] ?? ""}
                        disabled={!canSave}
                        spellCheck={false}
                        onChange={(e) => setLines((l) => setLineField(l, row, c.key, e.target.value))}
                      />
                    )}
                  </td>
                ))}
                <td className="erp-lines__act">
                  {canSave && (
                    <button type="button" className="erp-btn" aria-label={t("remove_line", { n: row + 1 })} onClick={() => setLines((l) => l.filter((_, i) => i !== row))}>
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canSave && (
        <div className="erp-lines__foot">
          <button type="button" className="erp-btn" onClick={() => setLines((l) => [...l, blankRuleLine()])}>
            {t("add_line")}
          </button>
          <span className="erp-small erp-muted">{t("paths_hint")}</span>
        </div>
      )}
      {!canSave && <p className="erp-small erp-muted">{t("read_only")}</p>}
      {canSave && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          {failed.panel.length > 0 && (
            <ul role="alert" className="erp-field__error">
              {failed.panel.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {flow.saving ? t("saving") : dirty && incomplete ? t("incomplete") : ""} <ProcessId id="accounting.posting_rule.update" />
            </span>
            {dirty && (
              <button type="button" className="erp-btn" disabled={flow.saving} onClick={() => setLines([...stored])}>
                {t("discard")}
              </button>
            )}
            <button type="button" className="erp-btn erp-btn--primary" disabled={!dirty || incomplete || flow.saving || flow.stepUp} onClick={() => void flow.submit(ruleLinesInput(ruleId, template, lines))}>
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
