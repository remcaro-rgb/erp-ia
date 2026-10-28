"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  DEFAULT_LABELS,
  MAX_ATTACHMENT_BYTES,
  TAG_OTHER,
  definedTags,
  fileIcon,
  formatSize,
  guessTag,
  isLoaded,
  kindLabel,
  missingTags,
  sameTag,
  stagedProblem,
  type AttachmentItem,
  type AttachmentsLabels,
  type RequiredTag,
  type StagedFile,
} from "./attachments-model";

export type { AttachmentItem, AttachmentsLabels, RequiredKind, RequiredTag } from "./attachments-model";

export interface AttachmentsPanelProps {
  /** Entity id of the owning record, e.g. `core.party`. */
  entity: string;
  /** The record's id; absent while the record is not saved yet. */
  recordId?: string | null;
  /** Hides the drop zone and the remove buttons. */
  readOnly?: boolean;
  /** The administrator's files that apply to this record (`kernel.required_attachments`). */
  requiredTags?: readonly RequiredTag[];
  /** Files already known (server-rendered); skips the first fetch. */
  initialAttachments?: readonly AttachmentItem[];
  /** Called with the current list after every upload or removal, so the form can refresh the record's readiness. */
  onChange?: (items: readonly AttachmentItem[]) => void;
  /** Copy overrides. Spanish defaults until packages/i18n is wired. */
  labels?: Partial<AttachmentsLabels>;
  /** Route handler of the attachments API. */
  endpoint?: string;
  /** Appended to the root's `erp-attachments` class. Parts are `erp-attachments__*`, pills `erp-pill erp-pill--ok|danger|gray|info`. */
  className?: string;
  /** Test seam; defaults to the global `fetch`. */
  fetcher?: typeof fetch;
}

/** The first message a failed API call carries. */
async function reasonOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { code?: string; details?: unknown } | null;
  const first = Array.isArray(body?.details) ? body.details[0] : undefined;
  return typeof first === "string" ? first : (body?.code ?? String(response.status));
}

/**
 * Attachments of one record (design §5.13, prototype v5 "Archivos" tab): the administrator's required
 * files with their state, a drop zone (drag-and-drop and chooser), a staging list asking a tag for
 * every file, and the stored files with signed downloads and a confirmed removal.
 */
export function AttachmentsPanel(props: AttachmentsPanelProps) {
  const { entity, recordId, readOnly = false, requiredTags = [], initialAttachments, onChange, endpoint = "/api/attachments", className } = props;
  const fetcher = props.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const labels: AttachmentsLabels = { ...DEFAULT_LABELS, ...props.labels };

  const [items, setItems] = useState<readonly AttachmentItem[]>(initialAttachments ?? []);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const nextKey = useRef(1);
  // Held in refs so the load effect does not rerun when a parent passes a new function or array each render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const url = useCallback((query: Record<string, string>) => `${endpoint}?${new URLSearchParams(query)}`, [endpoint]);
  const loadedInitially = initialAttachments !== undefined;

  useEffect(() => {
    if (!recordId || loadedInitially) return;
    let cancelled = false;
    fetcherRef
      .current(url({ entity, recordId }))
      .then(async (response) => {
        if (!response.ok) throw new Error(await reasonOf(response));
        if (!cancelled) setItems((await response.json()) as AttachmentItem[]);
      })
      .catch(() => {
        if (!cancelled) setMessage(labels.loadFailed);
      });
    return () => {
      cancelled = true;
    };
    // labels.loadFailed is copy, not a reason to refetch.
  }, [entity, recordId, loadedInitially, url]);

  const commit = (next: readonly AttachmentItem[]) => {
    setItems(next);
    changeRef.current?.(next);
  };

  const stageFiles = (files: Iterable<File>) => {
    const problems: string[] = [];
    const added: StagedFile[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) problems.push(labels.tooBig(file.name));
      else if (items.some((i) => i.fileName.toLowerCase() === file.name.toLowerCase()) || [...staged, ...added].some((s) => s.file.name.toLowerCase() === file.name.toLowerCase())) {
        problems.push(labels.duplicate(file.name));
      } else {
        added.push({ key: nextKey.current++, file, tag: guessTag(file.name, requiredTags, items), custom: false });
      }
    }
    setMessage(problems.length > 0 ? problems.join(" · ") : null);
    if (added.length > 0) setStaged((current) => [...current, ...added]);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    stageFiles(Array.from(event.dataTransfer.files));
  };

  const patchStaged = (key: number, patch: Partial<StagedFile>) =>
    setStaged((current) => current.map((s) => (s.key === key ? { ...s, ...patch, error: undefined } : s)));

  const uploadAll = async () => {
    if (!recordId) return;
    setBusy(true);
    setMessage(null);
    let current = items;
    const left: StagedFile[] = [];
    for (const s of staged) {
      const form = new FormData();
      form.set("entity", entity);
      form.set("recordId", recordId);
      form.set("tag", s.tag.trim());
      form.set("file", s.file);
      try {
        const response = await fetcherRef.current(endpoint, { method: "POST", body: form });
        if (!response.ok) throw new Error(await reasonOf(response));
        current = [...current, (await response.json()) as AttachmentItem];
      } catch (error) {
        left.push({ ...s, error: labels.failed(s.file.name, error instanceof Error ? error.message : String(error)) });
      }
    }
    setStaged(left);
    setBusy(false);
    if (current !== items) commit(current);
  };

  const download = async (item: AttachmentItem) => {
    try {
      const response = await fetcherRef.current(url({ id: item.id }));
      if (!response.ok) throw new Error(await reasonOf(response));
      const { url: signed } = (await response.json()) as { url: string };
      const link = document.createElement("a");
      link.href = signed;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.download = item.fileName;
      link.click();
    } catch (error) {
      setMessage(labels.actionFailed(error instanceof Error ? error.message : String(error)));
    }
  };

  const remove = async (item: AttachmentItem) => {
    setConfirming(null);
    try {
      const response = await fetcherRef.current(url({ id: item.id }), { method: "DELETE" });
      if (!response.ok) throw new Error(await reasonOf(response));
      commit(items.filter((i) => i.id !== item.id));
    } catch (error) {
      setMessage(labels.actionFailed(error instanceof Error ? error.message : String(error)));
    }
  };

  const tags = definedTags(requiredTags);
  const missing = recordId ? missingTags(requiredTags, items) : [];
  const readyToUpload = staged.length > 0 && staged.every((s) => stagedProblem(s, requiredTags, labels) === null);

  return (
    <div className={["erp-attachments", className].filter(Boolean).join(" ")}>
      {requiredTags.length > 0 && (
        <section className="erp-attachments__required">
          <h3>{labels.requiredTitle}</h3>
          <ul>
            {requiredTags.map((def) => {
              const has = recordId ? isLoaded(def, items) : false;
              const tone = has ? "ok" : def.required ? "danger" : "gray";
              return (
                <li key={def.tag}>
                  <span className={`erp-pill erp-pill--${tone}`}>{has ? labels.loaded : def.required ? labels.required : labels.optional}</span>{" "}
                  <b>{def.tag}</b>{" "}
                  <span className="erp-attachments__muted">
                    {kindLabel(def.kind, labels)}
                    {def.description ? ` · ${def.description}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
          {missing.length > 0 && <p className="erp-attachments__warning">{labels.missing(missing)}</p>}
        </section>
      )}

      {!recordId ? (
        <div className="erp-attachments__drop erp-attachments__drop--disabled">{labels.saveFirst}</div>
      ) : (
        !readOnly && (
          <div
            className={`erp-attachments__drop${over ? " erp-attachments__drop--over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <div>
              <b>{labels.dropTitle}</b> {labels.dropOr}{" "}
              <label className="erp-attachments__choose">
                {labels.choose}
                <input
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    stageFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
            <div className="erp-attachments__muted">{labels.dropHint}</div>
          </div>
        )
      )}

      {staged.length > 0 && (
        <section className="erp-attachments__stage">
          <h3>{labels.stageTitle}</h3>
          {staged.map((s) => {
            const isCustom = s.custom || (s.tag !== "" && !tags.some((t) => sameTag(t, s.tag)));
            const problem = s.tag === "" ? null : stagedProblem(s, requiredTags, labels);
            return (
              <div className="erp-attachments__row" key={s.key}>
                <span aria-hidden="true">{fileIcon(s.file.type)}</span>
                <div className="erp-attachments__name">
                  <div>{s.file.name}</div>
                  <div className="erp-attachments__muted">{formatSize(s.file.size)}</div>
                </div>
                <select
                  aria-label={`${labels.tagPlaceholder} ${s.file.name}`}
                  value={isCustom ? TAG_OTHER : s.tag}
                  onChange={(event) =>
                    event.target.value === TAG_OTHER ? patchStaged(s.key, { custom: true, tag: "" }) : patchStaged(s.key, { custom: false, tag: event.target.value })
                  }
                >
                  <option value="">{labels.tagPlaceholder}</option>
                  {tags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                  <option value={TAG_OTHER}>{labels.tagOther}</option>
                </select>
                {isCustom && (
                  <input
                    type="text"
                    aria-label={labels.tagName}
                    placeholder={labels.tagName}
                    value={s.tag === TAG_OTHER ? "" : s.tag}
                    maxLength={80}
                    onChange={(event) => patchStaged(s.key, { custom: true, tag: event.target.value })}
                  />
                )}
                <button type="button" aria-label={labels.unstage} onClick={() => setStaged((current) => current.filter((x) => x.key !== s.key))}>
                  ✕
                </button>
                {(s.error ?? problem) && (
                  <div role="alert" className="erp-attachments__error">
                    {s.error ?? problem}
                  </div>
                )}
              </div>
            );
          })}
          <div className="erp-attachments__row">
            <span className="erp-attachments__muted erp-attachments__grow">{readyToUpload ? labels.readyToUpload : labels.needsTag}</span>
            <button type="button" disabled={!readyToUpload || busy} onClick={() => void uploadAll()}>
              {busy ? labels.uploading : labels.upload(staged.length)}
            </button>
          </div>
        </section>
      )}

      <section className="erp-attachments__list">
        <h3>
          {labels.listTitle} <span className="erp-pill erp-pill--gray">{items.length}</span>
        </h3>
        {message && (
          <p role="status" className="erp-attachments__error">
            {message}
          </p>
        )}
        {items.length === 0 ? (
          <p className="erp-attachments__muted">{recordId ? labels.empty : ""}</p>
        ) : (
          items.map((item) =>
            confirming === item.id ? (
              <div className="erp-attachments__row erp-attachments__row--confirm" role="alertdialog" aria-label={labels.confirmRemove(item.fileName, item.tag)} key={item.id}>
                <span className="erp-attachments__grow">{labels.confirmRemove(item.fileName, item.tag)}</span>
                <button type="button" onClick={() => void remove(item)}>
                  {labels.confirmYes}
                </button>
                <button type="button" onClick={() => setConfirming(null)}>
                  {labels.confirmNo}
                </button>
              </div>
            ) : (
              <div className="erp-attachments__row" key={item.id}>
                <span aria-hidden="true">{fileIcon(item.mimeType)}</span>
                <div className="erp-attachments__name">
                  <div>
                    <span className="erp-pill erp-pill--info">{item.tag}</span> {item.fileName}
                  </div>
                  <div className="erp-attachments__muted">
                    {formatSize(item.sizeBytes)}
                    {item.uploadedByName ? ` · ${item.uploadedByName}` : ""} · {item.uploadedAt.slice(0, 16).replace("T", " ")}
                  </div>
                </div>
                <button type="button" onClick={() => void download(item)}>
                  {labels.download}
                </button>
                {!readOnly && (
                  <button type="button" aria-label={labels.remove(item.fileName)} onClick={() => setConfirming(item.id)}>
                    ✕
                  </button>
                )}
              </div>
            ),
          )
        )}
      </section>
    </div>
  );
}
