import type { SaveIssue } from "@erp/ui";

/**
 * The text of a refused tab action for the user: the process's own messages when it gave any (validation messages come
 * from the process), else the catalogue's `errors.<code>`. `translate` is `useTranslations("errors")`.
 */
export function refusalText(
  translate: { (key: string): string; has: (key: string) => boolean },
  failure: { code: string; details: readonly SaveIssue[] },
): string {
  const messages = failure.details.map((d) => (d.path?.length ? `${d.path.join(".")}: ${d.message}` : d.message));
  if (messages.length > 0) return messages.join(" · ");
  return translate.has(failure.code) ? translate(failure.code) : translate("unknown");
}
