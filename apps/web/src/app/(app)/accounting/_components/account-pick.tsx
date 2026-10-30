"use client";

import { useMemo } from "react";
import { EntityLookup, gridFetcher, type GridRow } from "@erp/ui";
import type { AccountLookup } from "@/lib/accounting/posting";

/** An account lookup box (accounts that take movements), the way the mapping tabs use it: the magnifier opens the advanced filter of the chart. */
export function AccountPick(props: {
  id: string;
  label: string;
  lookup: AccountLookup;
  value: { id: string; label: string } | null;
  disabled?: boolean;
  placeholder?: string;
  onPick: (account: { id: string; label: string } | null) => void;
}) {
  const fetcher = useMemo(() => gridFetcher("accounting.account"), []);
  return (
    <EntityLookup
      id={props.id}
      aria-label={props.label}
      entityLabel={props.lookup.entityLabel}
      fetcher={fetcher}
      fields={props.lookup.columns}
      baseFilters={[{ field: "allows_movement", op: "eq", value: true }, { field: "is_active", op: "eq", value: true }]}
      {...(props.placeholder ? { placeholder: props.placeholder } : {})}
      disabled={props.disabled ?? false}
      value={props.value}
      describe={(row: GridRow) => ({ label: String(row.code ?? row.id), sub: typeof row.name === "string" ? row.name : undefined })}
      onPick={(row) => props.onPick(row ? { id: row.id, label: `${String(row.code ?? "")} — ${String(row.name ?? "")}` } : null)}
    />
  );
}
