import type { SaveIssue } from "@erp/ui";

/**
 * The messages of a refusal: the pack's strings as they are (no field), Zod issues with the path of their field, and a
 * refused change of an admin batch (`{ index, message }`, kernel.admin.*.set_many) on the path `changes.<index>`, as
 * the Zod issue of that change would be.
 */
export function issuesOf(details: unknown): SaveIssue[] {
  if (!Array.isArray(details)) return [];
  return details.map((d): SaveIssue => {
    if (d && typeof d === "object" && "message" in d) {
      const index = (d as { index?: unknown }).index;
      if (typeof index === "number" && Number.isInteger(index)) return { path: ["changes", String(index)], message: String((d as { message: unknown }).message) };
      const path = Array.isArray((d as { path?: unknown }).path) ? (d as { path: unknown[] }).path.map(String) : [];
      return path.length > 0 ? { path, message: String((d as { message: unknown }).message) } : { message: String((d as { message: unknown }).message) };
    }
    return { message: String(d) };
  });
}
