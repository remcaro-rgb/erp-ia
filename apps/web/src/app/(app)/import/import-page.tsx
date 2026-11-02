"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatCellValue, formatCount, ImportDialog, ImportIcon, importPending, importProgress, LiveStatus, useCellTimeZone, useLivePoll, type ImportHistoryItem } from "@erp/ui";
import { requestStepUp } from "@/lib/auth/step-up-client";
import type { ImportPageData } from "@/lib/imports/load";

/** While an import is queued or running, the history is read again this often. */
const REFRESH_MS = 3000;

const STATUS_TONE: Record<string, string> = { done: "ok", failed: "danger", running: "info", queued: "gray" };

/** The history as the server has it now; a failed read rejects (the page says so and offers Reanudar). */
async function readHistory(): Promise<ImportHistoryItem[]> {
  const response = await fetch("/api/import");
  if (!response.ok) throw new Error(String(response.status));
  return (await response.json()) as ImportHistoryItem[];
}

/**
 * The import page: entity cards that open the import dialog, and the history with each import's errores.csv. While an
 * import is queued or running the history follows it (UI density audit M1): it says whether it is live, paused (hidden
 * browser tab) or offline and when it last read, survives a failed read with Reanudar, and shows each running import's
 * progress.
 */
export function ImportPage({ data }: { data: ImportPageData }) {
  const t = useTranslations();
  const locale = useLocale();
  const [open, setOpen] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const poll = useLivePoll({ initial: data.history, read: readHistory, pending: importPending, intervalMs: REFRESH_MS });
  const { value: items, refresh } = poll;
  // Dates in the company's zone, like every other date of the app.
  const timeZone = useCellTimeZone();
  const when = (iso: string) => formatCellValue({ type: "datetime" }, iso, { yes: "", no: "", timeZone });

  const downloadErrors = async (attachmentId: string) => {
    setFailure(null);
    const response = await fetch(`/api/attachments?${new URLSearchParams({ id: attachmentId }).toString()}`);
    const body = (await response.json().catch(() => null)) as { url?: string; code?: string } | null;
    if (!response.ok || !body?.url) return setFailure(t(`errors.${body?.code ?? "unknown"}`));
    window.open(body.url, "_blank", "noopener,noreferrer");
  };

  // A whole-import failure is a known code (`row_step_up_required`…) or the file's own message.
  const failureText = (error: string) => (t.has(`grid.import.failure.${error}`) ? t(`grid.import.failure.${error}`) : error);

  const screen = data.screens.find((s) => s.entity === open);
  return (
    <div className="erp-stack" data-testid="import-page">
      <div className="erp-row">
        <h1 className="text-xl font-semibold">{t("grid.import.page_title")}</h1>
        <span className="erp-small erp-muted">{t("grid.import.page_hint")}</span>
      </div>

      {data.screens.length === 0 ? (
        <div role="alert" className="erp-dian erp-dian--info">
          {t("grid.import.none")}
        </div>
      ) : (
        <div className="erp-modcards">
          {data.screens.map((s) => (
            <article key={s.entity} className="erp-card erp-modcard">
              <b>{s.title}</b>
              <div className="erp-small erp-muted">
                {t("grid.import.card_columns", { count: s.columns })} · {t("grid.import.card_hint")}
              </div>
              <div className="erp-row">
                <span className="erp-grow" />
                <button type="button" className="erp-btn erp-btn--primary" aria-label={t("grid.import.dialog_title", { entity: s.title.toLowerCase() })} onClick={() => setOpen(s.entity)}>
                  <ImportIcon />
                  {t("grid.import.title")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <section className="erp-card erp-stack erp-import__history">
        <div className="erp-row">
          <h2>{t("grid.import.history")}</h2>
          <span className="erp-grow" />
          <LiveStatus state={poll.state} at={poll.at} onResume={() => void poll.resume()} />
          <button type="button" className="erp-btn erp-btn--sm" onClick={() => void refresh()}>
            {t("grid.import.refresh")}
          </button>
        </div>
        {failure && (
          <div role="alert" className="erp-dian erp-dian--bad">
            {failure}
          </div>
        )}
        <table>
          <thead>
            <tr>
              <th>{t("grid.import.col_date")}</th>
              <th>{t("grid.import.col_entity")}</th>
              <th>{t("grid.import.col_file")}</th>
              <th>{t("grid.import.col_user")}</th>
              <th>{t("grid.import.col_status")}</th>
              <th className="erp-num">{t("grid.import.col_ok")}</th>
              <th className="erp-num">{t("grid.import.col_failed")}</th>
              <th>{t("grid.import.col_errors")}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={8} className="erp-muted" data-testid="import-history-empty">
                  <b>{t("grid.import.history_empty")}</b>
                  <div className="erp-small">{t("grid.import.history_empty_hint")}</div>
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id}>
                  <td className="erp-mono erp-small">
                    <time dateTime={item.createdAt}>{when(item.createdAt)}</time>
                  </td>
                  <td>{item.entity ? (data.titles[item.entity] ?? item.entity) : ""}</td>
                  <td>{item.fileName}</td>
                  <td>{item.startedByName}</td>
                  <td>
                    <span className={`erp-pill erp-pill--${STATUS_TONE[item.status ?? ""] ?? "gray"}`}>{item.status ? t(`grid.import.status.${item.status}`) : ""}</span>
                    <ImportProgressBar item={item} label={(done, total) => t("grid.import.progress", { done: formatCount(locale, done), total: formatCount(locale, total) })} />
                    {item.error && <div className="erp-small erp-muted">{failureText(item.error)}</div>}
                  </td>
                  <td className="erp-num">{item.rowsOk}</td>
                  <td className="erp-num">{item.rowsFailed}</td>
                  <td>
                    {item.errorsAttachmentId && (
                      <button type="button" className="erp-link" onClick={() => void downloadErrors(item.errorsAttachmentId!)}>
                        {t("grid.import.errors_file")}
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>

      {screen && (
        <ImportDialog
          open
          onOpenChange={(next) => !next && setOpen(null)}
          entity={screen.entity}
          entityLabel={screen.title}
          requestStepUp={requestStepUp}
          onStarted={() => void refresh()}
        />
      )}
    </div>
  );
}

/** The rows done of a running import, as a thin bar with its count for screen readers. */
function ImportProgressBar({ item, label }: { item: ImportHistoryItem; label: (done: number, total: number) => string }) {
  const progress = importProgress(item);
  if (!progress) return null;
  return (
    <div
      className="erp-bar"
      style={{ height: 4, marginTop: 4 }}
      role="progressbar"
      aria-label={label(progress.done, progress.total)}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-valuenow={progress.done}
    >
      <i style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
    </div>
  );
}
