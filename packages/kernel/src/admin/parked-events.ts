import type { Tx } from "../db/client";

// Events parked because the tenant never bought the consuming module (Task 50.9, owner 2026-11-06 decision item 9, Ruling R50-9): the
// dispatcher dead-letters them with `last_error = 'not_entitled:<module id>'`. They are read under RLS as the caller (the dead letter
// table is company-scoped) and counted per module for Admin › Módulos.

export interface ParkedEvents {
  moduleId: string;
  count: number;
}

/** The open (not dismissed) `not_entitled` dead letters of the active company, counted per module (whatever its gate is now: they stay visible until replayed or dismissed). */
export async function parkedNotEntitled(tx: Tx): Promise<ParkedEvents[]> {
  const rows = await tx<{ module_id: string; n: string }[]>`
    select substr(last_error, length('not_entitled:') + 1) as module_id, count(*) as n
    from kernel.outbox_dead_letter
    where company_id = kernel.current_company_id() and dismissed_at is null and last_error like 'not\_entitled:%'
    group by 1 order by 1`;
  return rows.map((r) => ({ moduleId: r.module_id, count: Number(r.n) }));
}
