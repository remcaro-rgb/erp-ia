import { NEW_RECORD_ID } from "./entities";

interface TabsActions {
  open: (tab: { title: string; href: string; kind: "record" }) => void;
  close: (id: string) => void;
  replace: (href: string) => void;
}

/**
 * After a «Crear …» tab created record `id` of `entity` (Task 17 round 1): the record's own tab opens and becomes active first, then
 * the «new» tab closes (no longer the active one, so the store activates no neighbour for the shell to navigate to), then the page
 * moves to the record. The record page renames its tab once loaded.
 */
export function openCreatedRecord(tabs: TabsActions, entity: string, id: string, title: string): void {
  const href = `/r/${entity}/${id}`;
  tabs.open({ title, href, kind: "record" });
  tabs.close(`/r/${entity}/${NEW_RECORD_ID}`);
  tabs.replace(href);
}
