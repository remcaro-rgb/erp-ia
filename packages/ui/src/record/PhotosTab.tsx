"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import {
  DEFAULT_PHOTOS_LABELS,
  MAX_ATTACHMENT_BYTES,
  PHOTO_TAG,
  isAiPhoto,
  isPhoto,
  type AttachmentItem,
  type PhotosLabels,
} from "./photos-model";

export type { PhotosLabels } from "./photos-model";

export interface PhotosTabProps {
  /** Entity id of the owning record, e.g. `core.product`. */
  entity: string;
  /** The record's id; absent while the record is not saved yet. */
  recordId?: string | null;
  /** Hides the drop zone, the removal and the AI button. */
  readOnly?: boolean;
  /**
   * Makes a photo the principal one: called with the photo ids in their new order (the chosen one first). The
   * tab shows the new order once it resolves. The "Hacer principal" button shows only when this is given.
   */
  onReorder?: (orderedIds: string[]) => Promise<void> | void;
  /** Runs `ai.image.suggest` for the record; the tab reloads the photos afterwards. The button shows only when this is given. */
  onSuggest?: () => Promise<void>;
  /** Route handler of the attachments API. */
  endpoint?: string;
  labels?: Partial<PhotosLabels>;
  /** Appended to the root's `erp-photos` class. */
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
 * "Fotos" of a product (design §5.18, prototype v5): a carousel with thumbnails, a drop zone and the
 * "Sugerir foto con IA" button. The first photo is the principal one. Files are attachments tagged `Foto`
 * handled by /api/attachments (25 MB, signed 60 s links), so they also show in the Archivos tab.
 */
export function PhotosTab({ entity, recordId, readOnly = false, onReorder, onSuggest, endpoint = "/api/attachments", labels: overrides, className, fetcher: injected }: PhotosTabProps) {
  const labels: PhotosLabels = { ...DEFAULT_PHOTOS_LABELS, ...overrides };
  const fetcherRef = useRef<typeof fetch>(injected ?? ((...args) => fetch(...args)));
  fetcherRef.current = injected ?? ((...args) => fetch(...args));
  const labelsRef = useRef(labels);
  labelsRef.current = labels;

  const [photos, setPhotos] = useState<readonly AttachmentItem[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [index, setIndex] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [suggesting, setSuggesting] = useState(false);

  const query = useCallback((params: Record<string, string>) => `${endpoint}?${new URLSearchParams(params)}`, [endpoint]);

  /** Signed links last 60 s, which is plenty for the browser to fetch each image once. */
  const sign = useCallback(
    async (items: readonly AttachmentItem[]) => {
      const entries = await Promise.all(
        items.map(async (photo) => {
          try {
            const response = await fetcherRef.current(query({ id: photo.id }));
            if (!response.ok) return null;
            return [photo.id, ((await response.json()) as { url: string }).url] as const;
          } catch {
            return null;
          }
        }),
      );
      setUrls((current) => ({ ...current, ...Object.fromEntries(entries.filter((e) => e !== null)) }));
    },
    [query],
  );

  const reload = useCallback(async () => {
    if (!recordId) return;
    try {
      const response = await fetcherRef.current(query({ entity, recordId }));
      if (!response.ok) throw new Error(await reasonOf(response));
      const items = ((await response.json()) as AttachmentItem[]).filter(isPhoto);
      setPhotos(items);
      setIndex((current) => Math.min(current, Math.max(0, items.length - 1)));
      await sign(items);
    } catch {
      setMessage(labelsRef.current.loadFailed);
    } finally {
      setLoaded(true);
    }
  }, [entity, recordId, query, sign]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const upload = async (files: File[]) => {
    if (!recordId) return;
    const problems: string[] = [];
    let current = photos;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        problems.push(labels.notImage(file.name));
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        problems.push(labels.tooBig(file.name));
        continue;
      }
      const form = new FormData();
      form.set("entity", entity);
      form.set("recordId", recordId);
      form.set("tag", PHOTO_TAG);
      form.set("file", file);
      try {
        const response = await fetcherRef.current(endpoint, { method: "POST", body: form });
        if (!response.ok) throw new Error(await reasonOf(response));
        const created = (await response.json()) as AttachmentItem;
        current = [...current, created];
        setPhotos(current);
        setIndex(current.length - 1);
        await sign([created]);
      } catch (error) {
        problems.push(labels.failed(file.name, error instanceof Error ? error.message : String(error)));
      }
    }
    setMessage(problems.length > 0 ? problems.join(" · ") : null);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    void upload(Array.from(event.dataTransfer.files));
  };

  const removeCurrent = async () => {
    const photo = photos[index];
    setConfirming(false);
    if (!photo) return;
    try {
      const response = await fetcherRef.current(query({ id: photo.id }), { method: "DELETE" });
      if (!response.ok) throw new Error(await reasonOf(response));
      const rest = photos.filter((p) => p.id !== photo.id);
      setPhotos(rest);
      setIndex(Math.min(index, Math.max(0, rest.length - 1)));
    } catch (error) {
      setMessage(labels.actionFailed(error instanceof Error ? error.message : String(error)));
    }
  };

  const makePrincipal = async () => {
    const photo = photos[index];
    if (!photo || index === 0) return;
    const reordered = [photo, ...photos.filter((p) => p.id !== photo.id)];
    try {
      await onReorder?.(reordered.map((p) => p.id));
      setPhotos(reordered);
      setIndex(0);
    } catch (error) {
      setMessage(labels.actionFailed(error instanceof Error ? error.message : String(error)));
    }
  };

  const suggest = async () => {
    if (!onSuggest) return;
    setSuggesting(true);
    setMessage(null);
    try {
      await onSuggest();
      await reload();
    } catch (error) {
      setMessage(labels.actionFailed(error instanceof Error ? error.message : String(error)));
    } finally {
      setSuggesting(false);
    }
  };

  if (!recordId) return <div className={["erp-photos", className].filter(Boolean).join(" ")}><div className="erp-photos__drop erp-photos__drop--disabled">{labels.saveFirst}</div></div>;

  const current = photos[index];
  return (
    <div className={["erp-photos", className].filter(Boolean).join(" ")}>
      <div className="erp-photos__carousel">
        {current ? (
          // A plain <img>: the signed Storage URL expires, so there is nothing for an image optimizer to cache.
          <img src={urls[current.id]} alt={current.fileName} />
        ) : (
          loaded && <div className="erp-photos__muted">{labels.empty}</div>
        )}
        {photos.length > 1 && (
          <>
            <button type="button" aria-label={labels.previous} onClick={() => setIndex((index - 1 + photos.length) % photos.length)}>
              ‹
            </button>
            <button type="button" aria-label={labels.next} onClick={() => setIndex((index + 1) % photos.length)}>
              ›
            </button>
          </>
        )}
        {current && (
          <span className={`erp-pill erp-pill--${isAiPhoto(current) ? "info" : "gray"}`}>
            {index === 0 ? `${labels.principal} · ` : ""}
            {isAiPhoto(current) ? labels.aiSuggested : labels.uploaded}
            {current.uploadedByName ? ` · ${current.uploadedByName}` : ""}
          </span>
        )}
      </div>

      <div className="erp-photos__strip">
        <div className="erp-photos__thumbs">
          {photos.map((photo, i) => (
            <button type="button" key={photo.id} className={i === index ? "erp-photos__thumb erp-photos__thumb--on" : "erp-photos__thumb"} onClick={() => setIndex(i)}>
              <img src={urls[photo.id]} alt={photo.fileName} />
            </button>
          ))}
        </div>
        {current && !readOnly && onReorder && index > 0 && (
          <button type="button" onClick={() => void makePrincipal()}>
            {labels.makePrincipal}
          </button>
        )}
        {current && !readOnly &&
          (confirming ? (
            <span role="alertdialog" aria-label={labels.confirmRemove}>
              {labels.confirmRemove}{" "}
              <button type="button" onClick={() => void removeCurrent()}>
                {labels.confirmYes}
              </button>{" "}
              <button type="button" onClick={() => setConfirming(false)}>
                {labels.confirmNo}
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirming(true)}>
              {labels.remove}
            </button>
          ))}
      </div>

      {message && (
        <p role="status" className="erp-photos__error">
          {message}
        </p>
      )}

      {!readOnly && (
        <>
          <div
            className={`erp-photos__drop${over ? " erp-photos__drop--over" : ""}`}
            onDragOver={(event) => {
              event.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
          >
            <div>
              <b>{labels.dropTitle}</b> {labels.dropOr}{" "}
              <label className="erp-photos__choose">
                {labels.choose}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    void upload(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />
              </label>
            </div>
            <div className="erp-photos__muted">{labels.dropHint}</div>
          </div>
          {onSuggest && (
            <div className="erp-photos__suggest">
              <button type="button" disabled={suggesting} onClick={() => void suggest()}>
                {suggesting ? labels.suggesting : labels.suggest}
              </button>
              <span className="erp-photos__muted">{labels.suggestHint}</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
