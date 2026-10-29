"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";
import { MAX_ATTACHMENT_BYTES } from "@erp/kernel/limits";
import { Dialog, DialogContent, DialogTitle } from "@erp/ui/components/ui/dialog";
import { StepUpPrompt } from "../forms/StepUpPrompt";
import type { RequestStepUp } from "../forms/save-model";
import { ExportIcon, ImportIcon } from "../grid/ExportButtons";
import { canRunImport, fileProblem, PREVIEW_COLUMNS, previewCounts, refusalOf, templateHref, type ImportPreviewData } from "./import-model";

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Registered entity id (`core.party`). */
  entity: string;
  /** The screen's name for the title ("Terceros"). */
  entityLabel: string;
  /** Turns a TOTP code into a step-up token (kernel.import.run is sensitive). */
  requestStepUp?: RequestStepUp;
  /** Called once the import started, with its id. */
  onStarted?: (importId: string) => void;
  /** Link to the import history. */
  historyHref?: string;
  endpoint?: string;
  fetcher?: typeof fetch;
}

type Phase = { kind: "idle" } | { kind: "checking" } | { kind: "running" } | { kind: "started" };

/**
 * The import dialog (design §9, prototype v5 "Importar"): 1 · the entity's Excel and CSV templates, 2 · a drop zone
 * (drag-and-drop or chooser), the preview of the file with each row's result from a dry run of the entity's create
 * process, and "Importar filas válidas", which runs kernel.import.run (asking the step-up code when needed) and
 * leaves the rest to the import workflow.
 */
export function ImportDialog(props: ImportDialogProps) {
  const t = useTranslations();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent showCloseButton={false} className="erp-dialog erp-import-dialog" aria-describedby={undefined}>
        <div className="erp-dialog__head">
          <DialogTitle className="erp-dialog__title">{t("grid.import.dialog_title", { entity: props.entityLabel.toLowerCase() })}</DialogTitle>
          <button type="button" className="erp-btn erp-btn--ghost" aria-label={t("common.close")} onClick={() => props.onOpenChange(false)}>
            ✕
          </button>
        </div>
        {props.open && <ImportDialogBody {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function ImportDialogBody({ entity, onOpenChange, requestStepUp, onStarted, historyHref = "/import", endpoint = "/api/import", fetcher }: ImportDialogProps) {
  const t = useTranslations();
  const fileInput = useRef<HTMLInputElement>(null);
  const fetchRef = useRef(fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args)));
  useEffect(() => {
    fetchRef.current = fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }, [fetcher]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreviewData | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [over, setOver] = useState(false);
  const [stepUp, setStepUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

  const post = (chosen: File, mode: "preview" | "run", stepUpToken?: string) => {
    const form = new FormData();
    form.set("entity", entity);
    form.set("mode", mode);
    form.set("file", chosen);
    if (stepUpToken) form.set("stepUpToken", stepUpToken);
    return fetchRef.current(endpoint, { method: "POST", body: form });
  };

  const choose = async (chosen: File | undefined) => {
    if (!chosen) return;
    setPreview(null);
    setFile(chosen);
    const problem = fileProblem(chosen, MAX_ATTACHMENT_BYTES);
    if (problem) return setMessage(t(`grid.import.${problem}`));
    setMessage(null);
    setPhase({ kind: "checking" });
    try {
      const response = await post(chosen, "preview");
      if (!response.ok) throw new Error((await refusalOf(response)).message);
      setPreview((await response.json()) as ImportPreviewData);
    } catch (error) {
      setMessage(t("grid.import.failed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally {
      setPhase({ kind: "idle" });
    }
  };

  const run = async (stepUpToken?: string) => {
    if (!file) return;
    setMessage(null);
    setPhase({ kind: "running" });
    try {
      const response = await post(file, "run", stepUpToken);
      if (!response.ok) {
        const refusal = await refusalOf(response);
        if (refusal.code === "step_up_required" && requestStepUp) {
          setStepUp(true);
          setPhase({ kind: "idle" });
          return;
        }
        throw new Error(refusal.message);
      }
      const { importId } = (await response.json()) as { importId: string };
      setStepUp(false);
      setPhase({ kind: "started" });
      onStarted?.(importId);
    } catch (error) {
      setMessage(t("grid.import.failed", { reason: error instanceof Error ? error.message : String(error) }));
      setPhase({ kind: "idle" });
    }
  };

  const confirmStepUp = async (code: string) => {
    if (!requestStepUp) return;
    setStepUpError(null);
    const answer = await requestStepUp(code);
    if ("error" in answer) return setStepUpError(answer.error);
    await run(answer.token);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    void choose(event.dataTransfer.files[0]);
  };

  if (phase.kind === "started") {
    return (
      <>
        <div className="erp-dialog__body">
          <div role="status" className="erp-dian erp-dian--ok">
            {t("grid.import.started")}
          </div>
        </div>
        <div className="erp-dialog__foot">
          <a className="erp-btn" href={historyHref}>
            {t("grid.import.history_link")}
          </a>
          <button type="button" className="erp-btn erp-btn--primary" onClick={() => onOpenChange(false)}>
            {t("common.close")}
          </button>
        </div>
      </>
    );
  }

  const counts = preview ? previewCounts(preview) : null;
  const shownHeaders = preview?.headers.slice(0, PREVIEW_COLUMNS) ?? [];
  return (
    <>
      <div className="erp-dialog__body">
        <section className="erp-sec">
          <h3>{t("grid.import.template_title")}</h3>
          <div className="erp-row erp-row--wrap">
            <a className="erp-btn" href={templateHref(endpoint, entity, "xlsx")} download>
              <ExportIcon format="xlsx" />
              {t("grid.import.template_xlsx")}
            </a>
            <a className="erp-btn" href={templateHref(endpoint, entity, "csv")} download>
              <ExportIcon format="csv" />
              {t("grid.import.template_csv")}
            </a>
            <span className="erp-small erp-muted">{t("grid.import.template_hint")}</span>
          </div>
        </section>

        <section className="erp-sec">
          <h3>{t("grid.import.file_title")}</h3>
          <div
            className={`erp-drop${over ? " erp-drop--over" : ""}`}
            data-testid="import-drop"
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <ImportIcon />
            <div>
              <b>{t("grid.import.drop")}</b> {t("grid.import.drop_or")}{" "}
              {/* A real button: Tab reaches it, Enter or Space opens the system chooser (rule 20). */}
              <button type="button" className="erp-link erp-link--inline" onClick={() => fileInput.current?.click()}>
                {t("grid.import.choose")}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,.csv,text/csv"
                hidden
                tabIndex={-1}
                onChange={(event) => {
                  void choose(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>
            <div className="erp-small">{t("grid.import.drop_hint")}</div>
          </div>
          {file && <div className="erp-small">{t("grid.import.file", { name: file.name })}</div>}
          {phase.kind === "checking" && <div className="erp-small erp-muted">{t("grid.import.checking")}</div>}
        </section>

        {preview && counts && (
          <section className="erp-sec">
            <h3>
              {t("grid.import.preview_title", { total: preview.total })} · <span className="erp-pill erp-pill--ok">{t("grid.import.valid", { count: counts.valid })}</span>
              <span className="erp-pill erp-pill--danger">{t("grid.import.invalid", { count: counts.invalid })}</span>
            </h3>
            {preview.missingColumns.length > 0 && (
              <div role="alert" className="erp-dian erp-dian--bad">
                {t("grid.import.missing_columns", { columns: preview.missingColumns.join(", ") })}
              </div>
            )}
            {preview.unknownHeaders.length > 0 && <div className="erp-small erp-muted">{t("grid.import.unknown_headers", { headers: preview.unknownHeaders.join(", ") })}</div>}
            <div className="erp-import__table">
              <table>
                <thead>
                  <tr>
                    <th>{t("grid.import.col_row")}</th>
                    <th>{t("grid.import.col_result")}</th>
                    {shownHeaders.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.rowNo}>
                      <td className="erp-num">{row.rowNo}</td>
                      <td className="erp-import__result">
                        {row.ok ? (
                          <span className="erp-pill erp-pill--ok">{t("grid.import.row_ok")}</span>
                        ) : (
                          <>
                            <span className="erp-pill erp-pill--danger">{t("grid.import.row_bad")}</span> <span className="erp-small">{row.errors.join(" · ")}</span>
                          </>
                        )}
                      </td>
                      {shownHeaders.map((h, i) => (
                        <td key={h} className="erp-small">
                          {row.cells[i]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.total > preview.rows.length && <div className="erp-small erp-muted">{t("grid.import.partial", { shown: preview.rows.length, total: preview.total })}</div>}
            <div className="erp-small erp-muted">{t("grid.import.preview_note")}</div>
          </section>
        )}

        {stepUp && <StepUpPrompt onConfirm={(code) => void confirmStepUp(code)} onCancel={() => setStepUp(false)} error={stepUpError} busy={phase.kind === "running"} />}
        {message && (
          <div role="alert" className="erp-dian erp-dian--bad">
            {message}
          </div>
        )}
        <div className="erp-small erp-muted">{t("grid.import.process_note")}</div>
      </div>
      <div className="erp-dialog__foot">
        <button type="button" className="erp-btn" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button type="button" className="erp-btn erp-btn--primary" disabled={!canRunImport(preview) || phase.kind !== "idle" || stepUp} onClick={() => void run()}>
          {phase.kind === "running" ? t("grid.import.running") : t("grid.import.run")}
        </button>
      </div>
    </>
  );
}
