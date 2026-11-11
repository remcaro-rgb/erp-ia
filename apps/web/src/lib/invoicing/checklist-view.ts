// The DIAN checklist screen's view model (plan 2B Task 35, R35-11): what `invoicing.dian_checklist.consult` answers, grouped in the pack's
// order, with the text of the caller's locale. Pure, so the mapping is tested without a page.

export interface ChecklistConsult {
  version: number;
  storedVersion: number | null;
  /** The effective confirmation (R35-7). */
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
  environment: string;
  progress: { done: number; total: number };
  items: {
    key: string;
    group: string;
    es: string;
    en: string;
    docUrl: string | null;
    ticked: boolean;
    tickedBy: string | null;
    tickedAt: string | null;
    isNew: boolean;
  }[];
}

export interface ChecklistItemView {
  key: string;
  text: string;
  docUrl: string | null;
  ticked: boolean;
  tickedBy: string | null;
  tickedAt: string | null;
  isNew: boolean;
}

export interface ChecklistView {
  groups: { group: string; items: ChecklistItemView[] }[];
  progress: { done: number; total: number };
  /** The items added since the confirmation was made (R35-8). */
  newItems: ChecklistItemView[];
  confirmed: boolean;
  confirmedAt: string | null;
  confirmedBy: string | null;
  /** Every item ticked and no effective confirmation yet. */
  canConfirm: boolean;
  /** In producción nothing is unticked (the confirmation cannot be withdrawn there). */
  locksUnticking: boolean;
}

export function checklistView(consult: ChecklistConsult, locale: string): ChecklistView {
  const english = locale === "en" || locale.startsWith("en-");
  const groups: ChecklistView["groups"] = [];
  const newItems: ChecklistItemView[] = [];
  for (const item of consult.items) {
    const view: ChecklistItemView = {
      key: item.key, text: english ? item.en : item.es, docUrl: item.docUrl, ticked: item.ticked, tickedBy: item.tickedBy, tickedAt: item.tickedAt, isNew: item.isNew,
    };
    let group = groups.find((g) => g.group === item.group);
    if (!group) groups.push((group = { group: item.group, items: [] }));
    group.items.push(view);
    if (item.isNew) newItems.push(view);
  }
  const { done, total } = consult.progress;
  return {
    groups,
    progress: { done, total },
    newItems,
    confirmed: consult.confirmed,
    confirmedAt: consult.confirmedAt,
    confirmedBy: consult.confirmedBy,
    canConfirm: total > 0 && done === total && !consult.confirmed,
    locksUnticking: consult.environment === "produccion",
  };
}
