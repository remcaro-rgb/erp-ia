/**
 * The open tab to rename to the report's own name: the one at the report's path that still carries another title — the
 * query-less tab the menu item "Informes" named, or one reopened with parameters that kept that generic title. A
 * drill-down tab (a query and its own title, "1105 · Caja · noviembre de 2026") keeps what it has.
 */
export function reportTabToRename<T extends { href: string; title: string }>(tabs: readonly T[], pathname: string, label: string, generic: string): T | undefined {
  return tabs.find((tab) => tab.href.split("?")[0] === pathname && tab.title !== label && (!tab.href.includes("?") || tab.title === generic));
}
