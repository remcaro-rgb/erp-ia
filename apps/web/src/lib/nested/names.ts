/**
 * A process's name for the nested-run screens where the catalogue has no label for it: its description (Spanish, from the registry) up to the first
 * colon or semicolon, at most 80 characters; the id itself when the registry does not know it.
 */
export function processName(id: string, description: string | undefined): string {
  const first = description?.split(/[:;]/)[0]?.trim();
  if (!first) return id;
  return first.length > 80 ? `${first.slice(0, 77).trimEnd()}…` : first;
}
