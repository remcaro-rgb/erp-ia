"use client";

import { useTranslations } from "next-intl";
import { PhotosTab } from "@erp/ui";
import { reorderPhotosAction, suggestPhotoAction } from "@/lib/records/tab-actions";
import type { RecordAbilities } from "@/lib/records/load";
import { refusalText } from "./refusal";

export interface PhotosPanelProps {
  entity: string;
  recordId: string;
  can: Pick<RecordAbilities, "attach" | "reorder" | "suggest">;
  /** What the picture suggestion is made from: the record's description, unit and category name. */
  hints: { description: string; uom?: string; category?: string };
}

/**
 * The Fotos tab of a product wired to the attachment processes. The tab uploads and removes through /api/attachments;
 * "Hacer principal" runs `kernel.attachment.reorder` (which also approves a suggested picture) and "Sugerir foto con
 * IA" runs `kernel.ai.image_suggest`. A control shows only when the caller's role may run its process.
 */
export function PhotosPanel({ entity, recordId, can, hints }: PhotosPanelProps) {
  const te = useTranslations("errors");
  return (
    <PhotosTab
      entity={entity}
      recordId={recordId}
      readOnly={!can.attach}
      onReorder={
        can.reorder
          ? async (orderedIds) => {
              const result = await reorderPhotosAction(entity, recordId, orderedIds);
              if (!result.ok) throw new Error(refusalText(te, result));
            }
          : undefined
      }
      onSuggest={
        can.suggest
          ? async () => {
              const result = await suggestPhotoAction(entity, recordId, hints);
              if (!result.ok) throw new Error(refusalText(te, result));
            }
          : undefined
      }
    />
  );
}
