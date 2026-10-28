"use client";

import { useRouter } from "next/navigation";
import { AttachmentsPanel, type AttachmentItem, type RequiredTag } from "@erp/ui";
import type { RecordAbilities } from "@/lib/records/load";

export interface FilesPanelProps {
  entity: string;
  recordId: string;
  requiredTags: readonly RequiredTag[];
  /** The record's files as the server just read them. */
  attachments: readonly AttachmentItem[];
  can: Pick<RecordAbilities, "attach" | "removeFile">;
}

/**
 * The Archivos tab wired to the record: the checklist of the admin's required files, and after every upload or
 * removal (here or in the Fotos tab) the page reloads the record so its footer (invoice readiness, DIAN status) and
 * this list reflect the files. The list comes with the page; the panel starts over when it changes.
 */
export function FilesPanel({ entity, recordId, requiredTags, attachments, can }: FilesPanelProps) {
  const router = useRouter();
  return (
    <AttachmentsPanel
      key={attachments.map((a) => `${a.id}:${a.suggested ? "s" : ""}`).join(",")}
      entity={entity}
      recordId={recordId}
      readOnly={!can.attach}
      canRemove={can.removeFile}
      requiredTags={requiredTags}
      initialAttachments={attachments}
      onChange={() => router.refresh()}
    />
  );
}
