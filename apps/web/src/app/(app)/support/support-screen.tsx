"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { DataGrid, defaultView, viewFromSaved, type GridRow, type SavedGridState } from "@erp/ui";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import { currentClone, finishClone, leaveClone, subscribeClones, takeClone } from "@/lib/records/clone-handoff";
import type { SupportPageData } from "@/lib/support/load";
import { NewTicketDialog } from "./new-ticket-dialog";
import { TicketSheet } from "./ticket-sheet";

const TICKET = "support.ticket";

/**
 * The tickets grid (design §8, §9) with "Nuevo ticket" for whoever may file one, the ticket opening in a side sheet
 * with its conversation, and ⌘K "Crear ticket de soporte" landing here with ?new=1.
 */
export function SupportScreen({ data }: { data: SupportPageData }) {
  const t = useTranslations();
  const { grid, canCreate } = data;
  const searchParams = useSearchParams();
  const [views, setViews] = useState(grid.views);
  // A change to a ticket remounts the grid, which reads the page again.
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [initialState] = useState(() => {
    const view = defaultView(grid.views);
    return view ? viewFromSaved(grid.columns, view.state) : { sort: [{ field: "seq", dir: "desc" as const }] };
  });

  // "Duplicar" on a ticket (rule 37) hands its copy to this screen's "Nuevo ticket" form: shown, it is taken once and
  // closes the ticket it came from; closing the form or leaving the screen lets it go.
  const copy = useSyncExternalStore(subscribeClones, () => (canCreate ? currentClone(TICKET) : null), () => null);
  useEffect(() => {
    if (canCreate) takeClone(TICKET);
  }, [copy, canCreate]);
  useEffect(() => () => leaveClone(TICKET), []);
  if (copy && openId !== null) setOpenId(null);
  const changeCreating = (open: boolean) => {
    setCreating(open);
    if (!open) finishClone(TICKET);
  };

  const handledNew = useRef(false);
  useEffect(() => {
    if (searchParams.get("new") !== "1" || handledNew.current || !canCreate) return;
    handledNew.current = true;
    setCreating(true);
  }, [searchParams, canCreate]);

  const changeViews = async (result: Awaited<ReturnType<typeof saveViewAction>>) => {
    if (!result.ok) throw new Error(result.code);
    setViews(result.views);
  };
  const refresh = () => setVersion((v) => v + 1);

  return (
    <>
      <DataGrid
        key={version}
        entity={grid.entity}
        title={grid.title}
        columns={grid.columns}
        initialState={initialState}
        onRowOpen={(row: GridRow) => setOpenId(row.id)}
        toolbar={
          canCreate ? (
            <button type="button" className="erp-btn erp-btn--primary" onClick={() => setCreating(true)}>
              {t("common.support.ui.new")}
            </button>
          ) : null
        }
        savedViews={{
          views,
          onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(grid.entity, name, isDefault, state)),
          onDelete: async (id: string) => changeViews(await deleteViewAction(grid.entity, id)),
        }}
      />
      {canCreate && (
        <NewTicketDialog
          open={creating || copy !== null}
          onOpenChange={changeCreating}
          copy={copy}
          onCreated={(id) => {
            refresh();
            setOpenId(id);
          }}
        />
      )}
      <TicketSheet id={openId} onClose={() => setOpenId(null)} onChanged={refresh} />
    </>
  );
}
