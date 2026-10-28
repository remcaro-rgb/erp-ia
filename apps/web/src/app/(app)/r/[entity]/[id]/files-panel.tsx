"use client";

import { useRouter } from "next/navigation";
import { AttachmentsPanel, type RequiredTag } from "@erp/ui";
import type { RecordAbilities } from "@/lib/records/load";

export interface FilesPanelProps {
  entity: string;
  recordId: string;
  requiredTags: readonly RequiredTag[];
  can: Pick<RecordAbilities, "attach">;
}

/**
 * The Archivos tab wired to the record: the checklist of the admin's required files, and after every upload or
 * removal the page reloads the record so its footer (invoice readiness, DIAN status) reflects the files.
 */
export function FilesPanel({ entity, recordId, requiredTags, can }: FilesPanelProps) {
  const router = useRouter();
  return <AttachmentsPanel entity={entity} recordId={recordId} readOnly={!can.attach} requiredTags={requiredTags} onChange={() => router.refresh()} />;
}
