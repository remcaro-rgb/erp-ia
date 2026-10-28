"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ExtraDataTab, failureMessages, StepUpPrompt, useSaveFlow, type ExtraDataValue, type ExtraFieldDef, type SaveRecord } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import { saveRecordAction } from "@/lib/records/actions";
import { extraChanges } from "@/lib/records/extra-patch";

export interface ExtraPanelProps {
  entity: string;
  recordId: string;
  defs: readonly ExtraFieldDef[];
  extra: Record<string, unknown>;
  extraFree: ExtraDataValue["extraFree"];
  /** The caller may run the entity's update process and their role does not have the `extra` column masked. */
  canEdit: boolean;
}

/**
 * The Datos adicionales tab wired to the entity's update process: edits stay in the tab until Guardar, which sends only
 * the keys of `extra` that changed (merged by the server into what is stored, so a form loaded earlier cannot overwrite
 * another user's values) and `extraFree` when it changed; the rest of the record is untouched. It asks for the step-up code when the process requires it
 * and shows the process's messages when it refuses a value.
 */
export function ExtraPanel({ entity, recordId, defs, extra, extraFree, canEdit }: ExtraPanelProps) {
  const router = useRouter();
  const t = useTranslations("common.extra_data");
  const tf = useTranslations("common.forms");
  const te = useTranslations("errors");
  const [baseline, setBaseline] = useState<ExtraDataValue>({ extra, extraFree: [...extraFree] });
  const [value, setValue] = useState<ExtraDataValue>(baseline);
  const [saved, setSaved] = useState(false);
  const save: SaveRecord = useCallback((input, token) => saveRecordAction(entity, input, token), [entity]);
  const flow = useSaveFlow(save, requestStepUp, () => {
    setBaseline(value);
    setSaved(true);
    router.refresh();
  });
  const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
  const failed = failureMessages(flow.failure, [], (code) => (te.has(code) ? te(code) : te("unknown")));

  return (
    <div>
      <ExtraDataTab
        defs={defs}
        extra={value.extra}
        extraFree={value.extraFree}
        readOnly={!canEdit}
        onChange={(next) => {
          setValue(next);
          setSaved(false);
        }}
      />
      {canEdit && (
        <div className="erp-form__actions">
          {flow.stepUp && <StepUpPrompt onConfirm={(code) => void flow.confirmStepUp(code)} onCancel={flow.cancelStepUp} error={flow.stepUpError} busy={flow.saving} />}
          {failed.panel.length > 0 && (
            <ul role="alert" className="erp-field__error">
              {failed.panel.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          )}
          <div className="erp-row">
            <span className="erp-small erp-muted erp-grow" role="status">
              {flow.saving ? t("saving") : saved && !dirty ? t("saved") : ""} <span className="erp-mono">{tf("process", { process: `${entity}.update` })}</span>
            </span>
            {dirty && (
              <button
                type="button"
                className="erp-btn"
                disabled={flow.saving}
                onClick={() => {
                  setValue(baseline);
                  setSaved(false);
                }}
              >
                {t("discard")}
              </button>
            )}
            <button type="button" className="erp-btn erp-btn--primary" disabled={!dirty || flow.saving} onClick={() => void flow.submit({ id: recordId, ...extraChanges(baseline, value) })}>
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
