/**
 * The text for a refused support action: the process's own first non-blank message, else the catalogue's text for
 * the error code, else the generic one. `refusal()` turns a missing message into "", which must never reach the user.
 */
export function failureText(failure: { code: string; details: readonly string[] }, has: (key: string) => boolean, t: (key: string) => string): string {
  const own = failure.details.map((d) => d.trim()).find((d) => d !== "");
  if (own) return own;
  return has(`errors.${failure.code}`) ? t(`errors.${failure.code}`) : t("errors.unknown");
}
