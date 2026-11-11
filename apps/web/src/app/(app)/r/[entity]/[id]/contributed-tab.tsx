"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { DataGrid, EntityLookup, failureMessages, gridFetcher, StepUpPrompt, useSaveFlow, type GridRow, type SaveRecord } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import type { LoadedContribution, MappingChoice } from "@/lib/records/contributed-load";
import { runContributedAction, saveMappingAction } from "@/lib/records/contributed-actions";
import { useStepRunner } from "@/lib/records/use-step-runner";

// A tab another module's manifest adds to the record page (`ModuleDef.recordTabs`, design §5.16). The kernel draws it
// from the contribution alone: a `grid` is the source view's rows for this record, a `mapping` is one lookup per role.

export interface ContributedTabProps {
  entityId: string;
  recordId: string;
  tab: LoadedContribution;
}

/** How a record of the lookup entity reads: its display field and, when it has one, its name (`1105 — Caja`). */
const rowLabel = (row: GridRow, displayField: string): string => {
  const main = String(row[displayField] ?? "");
  return typeof row.name === "string" && displayField !== "name" && row.name ? `${main} — ${row.name}` : main;
};

export function ContributedTab({ entityId, recordId, tab }: ContributedTabProps) {
  if (tab.kind === "grid") return <GridContribution entityId={entityId} recordId={recordId} tab={tab} />;
  return <MappingContribution entityId={entityId} recordId={recordId} tab={tab} />;
}

// Order matters to apps/web/src/i18n/auth-copy.test.ts: the first translator in a file names the namespace for every literal key the file asks for.

/** One lookup per role, saved together through the contribution's process (step-up prompt when it asks for one). */
function MappingContribution({ entityId, recordId, tab }: ContributedTabProps) {
  const router = useRouter();
  const t = useTranslations("common.record.contributed");
  const tf = useTranslations("common.forms");
  const te = useTranslations("errors");
  const tr = useTranslations("common.record.contributed.roles");
  const mapping = tab.mapping!;
  const lookup = tab.lookup;
  const [baseline, setBaseline] = useState<Record<string, MappingChoice | null>>(tab.values ?? {});
  const [values, setValues] = useState(baseline);
  const [saved, setSaved] = useState(false);
  const fetcher = useMemo(() => gridFetcher(mapping.lookupEntity), [mapping.lookupEntity]);
  const save: SaveRecord = useCallback(
    (input, token) => saveMappingAction(entityId, tab.id, recordId, input.picks as Array<{ role: string; accountId: string | null }>, token),
    [entityId, tab.id, recordId],
  );
  const flow = useSaveFlow(save, requestStepUp, () => {
    setBaseline(values);
    setSaved(true);
    router.refresh();
  });
  const dirty = mapping.roles.some((role) => (values[role]?.id ?? null) !== (baseline[role]?.id ?? null));
  const failed = failureMessages(flow.failure, [], (code) => (te.has(code) ? te(code) : te("unknown")));
  const roleName = (role: string) => (tr.has(role) ? tr(role) : role);
  const editable = mapping.canSave && lookup !== undefined;

  return (
    <div className="erp-stack">
      {mapping.roles.map((role) => (
        <div key={role} className="erp-field">
          <label className="erp-field__label" htmlFor={`${tab.id}-${role}`}>
            {roleName(role)}
          </label>
          {lookup ? (
            <EntityLookup
              id={`${tab.id}-${role}`}
              aria-label={roleName(role)}
              entityLabel={lookup.entityLabel}
              fetcher={fetcher}
              fields={lookup.columns}
              placeholder={t("choose")}
              disabled={!editable}
              value={values[role] ?? null}
              describe={(row: GridRow) => ({ label: String(row[lookup.displayField] ?? row.id), sub: typeof row.name === "string" ? row.name : undefined })}
              onPick={(row) => {
                setValues((current) => ({ ...current, [role]: row ? { id: row.id, label: rowLabel(row, lookup.displayField) } : null }));
                setSaved(false);
              }}
            />
          ) : (
            <span className="erp-muted">{values[role]?.label ?? "—"}</span>
          )}
        </div>
      ))}
      {!mapping.canSave && <p className="erp-small erp-muted">{t("read_only")}</p>}
      {editable && (
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
              {flow.saving ? t("saving") : saved && !dirty ? t("saved") : ""} <span className="erp-mono">{tf("process", { process: mapping.saveProcess })}</span>
            </span>
            {dirty && (
              <button
                type="button"
                className="erp-btn"
                disabled={flow.saving}
                onClick={() => {
                  setValues(baseline);
                  setSaved(false);
                }}
              >
                {t("discard")}
              </button>
            )}
            <button
              type="button"
              className="erp-btn erp-btn--primary"
              disabled={!dirty || flow.saving}
              onClick={() => void flow.submit({ picks: mapping.roles.map((role) => ({ role, accountId: values[role]?.id ?? null })) })}
            >
              {t("save")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The source view filtered to the record (`source_entity`, `source_record_id`, or the contribution's record field), read through POST
 * /api/grid/<view>; with the contribution's button (Task 29.4, RG-9: «Crear alistamiento») when the caller may run it. The button's process
 * answers for itself: a sensitive one asks for the step-up code, a refusal shows its reasons, a run that made nothing says why, and the page
 * reloads with what it made. A caller who may run the button but not read the source sees the button and a line instead of the grid.
 */
function GridContribution({ entityId, recordId, tab }: ContributedTabProps) {
  // The action's label and reasons are the module's keys (whole paths).
  const t = useTranslations();
  const tc = useTranslations("common.record.contributed");
  const tf = useTranslations("common.forms");
  const te = useTranslations("errors");
  const router = useRouter();
  const [note, setNote] = useState<string | null>(null);
  // The grid starts over after the button made something (its rows changed under it).
  const [round, setRound] = useState(0);
  const action = tab.action;
  // A sensitive process (rule 15) answers step_up_required: the runner asks for the code and runs it again with the token.
  const step = useStepRunner(
    (_step: "run", _input: Record<string, unknown>, token?: string) => runContributedAction(entityId, tab.id, recordId, token),
    (out) => {
      const reason = out.reason && action ? `${action.label}_reasons.${out.reason}` : null;
      setNote(reason ? (t.has(reason) ? t(reason) : out.reason) : null);
      setRound((n) => n + 1);
      router.refresh();
    },
  );
  const failed = step.failure ? (step.failure.messages.length > 0 ? step.failure.messages.join(" · ") : te.has(step.failure.code) ? te(step.failure.code) : te("unknown")) : null;
  return (
    <div className="erp-stack">
      {action && (
        <div className="erp-row">
          <button
            type="button"
            className="erp-btn erp-btn--primary"
            disabled={step.busy}
            onClick={() => {
              setNote(null);
              step.run("run");
            }}
          >
            {t(action.label)}
          </button>
          <span className="erp-small erp-muted erp-mono">{tf("process", { process: action.process })}</span>
        </div>
      )}
      {step.stepUp && <StepUpPrompt onConfirm={(code) => void step.confirm(code)} onCancel={step.cancel} error={step.stepUpError} busy={step.busy} />}
      {failed && (
        <div className="erp-dian erp-dian--bad" role="alert">
          {failed}
        </div>
      )}
      {note && (
        <div className="erp-small erp-muted" role="status">
          {note}
        </div>
      )}
      {tab.gridHidden ? (
        <p className="erp-small erp-muted">{tc("grid_hidden")}</p>
      ) : (
        <DataGrid key={round} entity={tab.source!} title={tab.gridTitle ? t(tab.gridTitle) : tab.source!} columns={tab.gridColumns ?? []} baseFilters={tab.filters} />
      )}
    </div>
  );
}
