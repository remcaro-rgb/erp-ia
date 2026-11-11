import { browserDownload } from "@erp/ui";

/**
 * Hands over a finished print (an export job of kernel.doc_template.print) by its signed link, as Imprimir does: true when the browser
 * got the file.
 */
export async function downloadPrint(fileId: string): Promise<boolean> {
  const response = await fetch(`/api/export/${encodeURIComponent(fileId)}`, { cache: "no-store" });
  const job = (await response.json().catch(() => null)) as { url?: string; fileName?: string } | null;
  if (!response.ok || !job?.url) return false;
  browserDownload({ kind: "link", url: job.url, ...(job.fileName ? { fileName: job.fileName } : {}) });
  return true;
}
