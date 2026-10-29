"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AttachmentsPanel, attachmentsLabels, type AttachmentItem, type RequiredTag } from "@erp/ui";
import type { RecordAbilities } from "@/lib/records/load";

export interface FilesPanelProps {
  entity: string;
  recordId: string;
  requiredTags: readonly RequiredTag[];
  /** The record's files as the server just read them; null when the caller's role may not list them (the panel then loads, and says so when it cannot). */
  attachments: readonly AttachmentItem[] | null;
  can: Pick<RecordAbilities, "attach" | "removeFile">;
}

/**
 * The Archivos tab wired to the record: the checklist of the admin's required files, and after every upload or
 * removal (here or in the Fotos tab) the page reloads the record so its footer (invoice readiness, DIAN status) and
 * this list reflect the files. The list comes with the page and the panel follows it without remounting, so files staged
 * in the meantime and the messages of a partial upload stay.
 */
export function FilesPanel({ entity, recordId, requiredTags, attachments, can }: FilesPanelProps) {
  const router = useRouter();
  const t = useTranslations("common.attachments");
  const te = useTranslations("errors");
  const locale = useLocale();
  // The tab's copy from the catalogue (rule 24); an API refusal code reads as its errors.* text when there is one.
  const labels = useMemo(() => attachmentsLabels(t, locale, (code) => (te.has(code) ? te(code) : code)), [t, te, locale]);
  return (
    <AttachmentsPanel
      entity={entity}
      recordId={recordId}
      labels={labels}
      readOnly={!can.attach}
      canRemove={can.removeFile}
      requiredTags={requiredTags}
      initialAttachments={attachments ?? undefined}
      onChange={() => router.refresh()}
    />
  );
}
