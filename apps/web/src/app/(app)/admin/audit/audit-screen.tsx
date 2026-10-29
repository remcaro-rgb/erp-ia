"use client";

import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { DataGrid, defaultView, gridFetcher, Pill, shortId, viewFromSaved, type CellRenderer, type GridFetcher, type GridRow, type SavedGridState } from "@erp/ui";
import { auditTitlesAction } from "@/lib/admin/audit-actions";
import { actorHref, auditRecordHref, SYSTEM_ACTOR, type AuditCatalogue } from "@/lib/admin/audit-links";
import type { AuditPageData } from "@/lib/admin/load";
import { deleteViewAction, saveViewAction } from "@/lib/grid/actions";
import { AuditDetailSheet } from "./audit-detail-sheet";

/** What every row needs, shown or not: the names and links of its cells (design §22.14, rule 21). */
const ROW_FIELDS = ["process_id", "entity", "row_id", "actor", "actor_user_id", "source_row_id"];

const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** A link inside a row: it opens its page, not the row's detail. */
function CellLink({ href, children, title }: { href: string; children: React.ReactNode; title?: string }) {
  return (
    <a className="erp-link erp-link--inline" href={href} title={title} onClick={(event: MouseEvent) => event.stopPropagation()}>
      {children}
    </a>
  );
}

/**
 * The audit grid (prototype v5 renderAudit, design §22.14): the universal DataGrid over `kernel.audit`, newest first, with
 * the filter row, the advanced filter, the export buttons and saved views. Its cells name what the ids stand for: Proceso
 * by its description (the id below), Entidad by its catalogue name, Registro and Actor as links to their pages, Origen with
 * "clonado desde" and the source record of a clone. A row opens its detail: each changed field, before and after.
 */
export function AuditScreen({ data }: { data: AuditPageData }) {
  const t = useTranslations();
  const [views, setViews] = useState(data.views);
  const [openId, setOpenId] = useState<string | null>(null);
  // The grid starts from the user's default view, when they saved one.
  const [initialState] = useState(() => {
    const view = defaultView(data.views);
    return view ? viewFromSaved(data.columns, view.state) : undefined;
  });
  const catalogue: AuditCatalogue = data.catalogue;

  // Titles of the records the page's rows name, read after each page through their masked views.
  const [titles, setTitles] = useState<Record<string, string>>({});
  const asked = useRef(new Set<string>());
  const fetcher = useMemo<GridFetcher>(() => {
    const base = gridFetcher(data.entity);
    return async (state, signal) => {
      const page = await base({ ...state, columns: [...new Set([...(state.columns ?? []), ...ROW_FIELDS])] }, signal);
      const refs = page.rows.flatMap((row) => {
        const entity = text(row.entity);
        if (!entity || !catalogue.entities[entity]) return [];
        return [text(row.row_id), text(row.source_row_id)].filter((id): id is string => id !== null && !asked.current.has(id)).map((id) => ({ entity, id }));
      });
      if (refs.length > 0) {
        for (const ref of refs) asked.current.add(ref.id);
        void auditTitlesAction(refs)
          .then((found) => setTitles((current) => ({ ...current, ...found })))
          .catch(() => {
            for (const ref of refs) asked.current.delete(ref.id);
          });
      }
      return page;
    };
  }, [data.entity, catalogue]);

  const recordLink = useCallback(
    (entity: string | null, id: string) => {
      const href = auditRecordHref(entity ? catalogue.entities[entity]?.id : null, id);
      const label = titles[id] ?? shortId(id);
      return href ? (
        <CellLink href={href} title={id}>
          {label}
        </CellLink>
      ) : (
        <span className={titles[id] ? undefined : "erp-mono"} title={id}>
          {label}
        </span>
      );
    },
    [catalogue, titles],
  );

  const renderCell = useCallback<CellRenderer>(
    (column, row: GridRow) => {
      const entity = text(row.entity);
      switch (column.field) {
        case "process_id": {
          const id = text(row.process_id);
          if (!id) return undefined;
          const description = catalogue.processes[id];
          if (!description) return <span className="erp-mono">{id}</span>;
          return (
            <span className="erp-cell-stack" title={description}>
              <span className="erp-cell-stack__main">{description}</span>
              <span className="erp-cell-stack__sub erp-mono">{id}</span>
            </span>
          );
        }
        case "entity": {
          const named = entity ? catalogue.entities[entity] : undefined;
          if (!entity) return undefined;
          return named ? <span title={entity}>{named.label}</span> : <span className="erp-mono">{entity}</span>;
        }
        case "row_id": {
          const id = text(row.row_id);
          return id ? recordLink(entity, id) : undefined;
        }
        case "actor": {
          const userId = text(row.actor_user_id);
          if (userId === SYSTEM_ACTOR) return <span className="erp-muted">{t("common.admin.audit.system")}</span>;
          const email = text(row.actor);
          const name = (userId ? catalogue.members[userId] : undefined) ?? email ?? (userId ? shortId(userId) : null);
          if (!name) return undefined;
          const href = actorHref(userId);
          return (
            <span className="erp-cell-stack">
              <span className="erp-cell-stack__main">{href ? <CellLink href={href}>{name}</CellLink> : name}</span>
              {email && email !== name && <span className="erp-cell-stack__sub">{email}</span>}
            </span>
          );
        }
        case "origin": {
          const source = text(row.source_row_id);
          if (!source) return undefined;
          const origin = String(row.origin ?? "");
          const label = column.options?.find((o) => o.value === origin)?.label ?? origin;
          const tone = column.pills?.[origin];
          return (
            <span className="erp-audit__origin">
              {tone ? <Pill tone={tone}>{label}</Pill> : label}
              <span className="erp-small">
                {t("common.admin.audit.cloned_from")} {recordLink(entity, source)}
              </span>
            </span>
          );
        }
        default:
          return undefined;
      }
    },
    [catalogue, recordLink, t],
  );

  const changeViews = async (result: Awaited<ReturnType<typeof saveViewAction>>) => {
    if (!result.ok) throw new Error(result.code);
    setViews(result.views);
  };

  return (
    <div className="erp-stack">
      <p className="erp-small erp-muted">{t("common.admin.audit.hint")}</p>
      <DataGrid
        entity={data.entity}
        title={data.title}
        columns={data.columns}
        fetcher={fetcher}
        initialState={initialState}
        renderCell={renderCell}
        onRowOpen={(row) => setOpenId(row.id)}
        savedViews={{
          views,
          onSave: async (name: string, isDefault: boolean, state: SavedGridState) => changeViews(await saveViewAction(data.entity, name, isDefault, state)),
          onDelete: async (id: string) => changeViews(await deleteViewAction(data.entity, id)),
        }}
      />
      <AuditDetailSheet id={openId} catalogue={catalogue} onClose={() => setOpenId(null)} />
    </div>
  );
}
