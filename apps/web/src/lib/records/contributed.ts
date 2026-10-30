import type { RecordTabContribution, Registry } from "@erp/kernel";

// The tabs other modules' manifests add to a record page (`ModuleDef.recordTabs`, design §5.16): which of them this
// record shows. Pure over a probe, so the rules are tested without a database; `load.ts` builds the real probe.

/** An equality filter on the source view. */
export interface ContributionFilter {
  field: string;
  op: "eq";
  value: string;
}

/** What resolving a contribution needs to ask, as the caller. */
export interface ContributionProbe {
  /** The company holds the feature (`m.f`). */
  entitled(feature: string): Promise<boolean>;
  /** Rows of the source view for the filters, or null when the caller may not read it. */
  rowCount(source: string, filters: ContributionFilter[]): Promise<number | null>;
  /** Process ids one of the caller's roles may run. */
  runnable: ReadonlySet<string>;
}

/** A contribution as it shows on one record. */
export interface ContributedTab {
  id: string;
  /** i18n key. */
  label: string;
  kind: RecordTabContribution["kind"];
  /** grid: rows of the source for the record (always at least 1 on a shown tab). */
  count?: number;
  source?: string;
  /** grid: the filters that narrow the source to the record. */
  filters?: ContributionFilter[];
  mapping?: {
    /** The dimension with `{id}` replaced by the record id. */
    dimension: string;
    roles: string[];
    lookupEntity: string;
    saveProcess: string;
    consultProcess?: string;
    /** The caller may run the save process; without it the tab is read-only. */
    canSave: boolean;
  };
}

/** Every process a record page's contributions may need asked about in one round trip. */
export function contributionProcesses(registry: Registry, entityId: string): string[] {
  return registry.recordTabsFor(entityId).flatMap((c) => [c.saveProcess, c.consultProcess].filter((p): p is string => p !== undefined));
}

/**
 * The contributed tabs `entityId`'s record `recordId` shows, in manifest order: the company must hold the contribution's
 * feature; a `grid` needs rows in its source for the record, a `mapping` needs the caller to be allowed its save or consult
 * process (the save is what makes it editable).
 */
export async function resolveContributedTabs(registry: Registry, entityId: string, recordId: string, probe: ContributionProbe): Promise<ContributedTab[]> {
  const tabs: ContributedTab[] = [];
  for (const c of registry.recordTabsFor(entityId)) {
    if (!(await probe.entitled(c.feature))) continue;
    if (c.kind === "grid") {
      const filters: ContributionFilter[] = [
        { field: "source_entity", op: "eq", value: entityId },
        { field: "source_record_id", op: "eq", value: recordId },
      ];
      const count = await probe.rowCount(c.source!, filters);
      if (count === null || count < 1) continue;
      tabs.push({ id: c.id, label: c.label, kind: "grid", count, source: c.source!, filters });
      continue;
    }
    const canSave = probe.runnable.has(c.saveProcess!);
    if (!canSave && !(c.consultProcess && probe.runnable.has(c.consultProcess))) continue;
    tabs.push({
      id: c.id,
      label: c.label,
      kind: "mapping",
      mapping: {
        dimension: c.dimension!.replaceAll("{id}", recordId),
        roles: c.roles!,
        lookupEntity: c.lookupEntity!,
        saveProcess: c.saveProcess!,
        ...(c.consultProcess ? { consultProcess: c.consultProcess } : {}),
        canSave,
      },
    });
  }
  return tabs;
}
