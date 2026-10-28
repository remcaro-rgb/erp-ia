"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { PhotosTab } from "@erp/ui";
import { reorderPhotosAction, suggestPhotoAction } from "@/lib/records/tab-actions";
import type { RecordAbilities } from "@/lib/records/load";
import { refusalText } from "./refusal";
import { useStepUpAction } from "../../../_components/use-step-up";

export interface PhotosPanelProps {
  entity: string;
  recordId: string;
  can: Pick<RecordAbilities, "attach" | "removeFile" | "reorder" | "suggest">;
  /** What the picture suggestion is made from: the record's description, unit and category name. */
  hints: { description: string; uom?: string; category?: string };
}

/**
 * The Fotos tab of a product wired to the attachment processes. The tab uploads and removes through /api/attachments;
 * "Hacer principal" runs `kernel.attachment.reorder` (which also approves a suggested picture) and "Sugerir foto con
 * IA" runs `kernel.ai.image_suggest`. A control shows only when the caller's role may run its process, a sensitive
 * process asks for the step-up code, and after every change the page reloads the record: the footer (invoice
 * readiness), the required-files checklist and the Archivos list follow the photos.
 */
export function PhotosPanel({ entity, recordId, can, hints }: PhotosPanelProps) {
  const router = useRouter();
  const te = useTranslations("errors");
  const { run, prompt } = useStepUpAction();
  return (
    <>
      {prompt}
      <PhotosTab
        entity={entity}
        recordId={recordId}
        readOnly={!can.attach}
        canRemove={can.removeFile}
        onChange={() => router.refresh()}
        onReorder={
          can.reorder
            ? async (orderedIds) => {
                const result = await run((token) => reorderPhotosAction(entity, recordId, orderedIds, token));
                if (!result.ok) throw new Error(refusalText(te, result));
              }
            : undefined
        }
        onSuggest={
          can.suggest
            ? async () => {
                const result = await run((token) => suggestPhotoAction(entity, recordId, hints, token));
                if (!result.ok) throw new Error(refusalText(te, result));
              }
            : undefined
        }
      />
    </>
  );
}
