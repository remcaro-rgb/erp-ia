import type { SaveIssue } from "@erp/ui";

/** The messages of a refusal: the pack's strings as they are (no field), Zod issues with the path of their field. */
export function issuesOf(details: unknown): SaveIssue[] {
  if (!Array.isArray(details)) return [];
  return details.map((d): SaveIssue => {
    if (d && typeof d === "object" && "message" in d) {
      const path = Array.isArray((d as { path?: unknown }).path) ? (d as { path: unknown[] }).path.map(String) : [];
      return path.length > 0 ? { path, message: String((d as { message: unknown }).message) } : { message: String((d as { message: unknown }).message) };
    }
    return { message: String(d) };
  });
}
