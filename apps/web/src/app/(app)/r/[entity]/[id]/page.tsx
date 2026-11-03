import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getLocale, getTranslations } from "next-intl/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { extraTabCounts, recordHref, recordTabIds, type RecordTab } from "@erp/ui";
import { formatLabel, NoAccess, OriginTab, Pill, VersionsTab } from "@erp/ui";
import { MASKED } from "@/lib/records/lifecycle-load";
import { AccessPanel } from "./access-panel";
import { accountingContent } from "./accounting-content";
import { loadRecord } from "@/lib/records/load";
import { ContactsPanel } from "./contacts-panel";
import { ContributedTab } from "./contributed-tab";
import { ExtraPanel } from "./extra-panel";
import { FilesPanel } from "./files-panel";
import { PhotosPanel } from "./photos-panel";
import { RecordForm } from "./record-form";
import { AppRecordFrame } from "./record-frame";
import { RecordStatus } from "./record-status";
import { untitledRecordTitle } from "@/lib/records/record-title";
import { TicketView } from "../../../support/ticket-view";

// Full-page record (design §5.16): /r/<entity>/<id> renders the record frame with the entity's Datos form (party,
// product, category) and the Contactos, Fotos, Datos adicionales and Archivos tabs; /r/<entity>/new is the empty form,
// or the copy "Duplicar" opened it with (rule 37).

type Params = Promise<{ entity: string; id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** "Abrir en una pestaña nueva": the record alone in its own browser tab (`?view=full`), using all the width. */
const FULL_VIEW = "?view=full";

async function RecordView({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const { entity: entityId, id } = await params;
  const full = (await searchParams).view === "full";
  // A malformed escape in the URL is a missing record, not a server error.
  let entityName: string;
  try {
    entityName = decodeURIComponent(entityId);
  } catch {
    notFound();
  }
  // A support ticket has its own frame (Datos, Mensajes…): the same view the support screen opens in its sheet.
  if (entityName === "support.ticket") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();
    return (
      <div className={full ? "w-full" : "mx-auto w-full max-w-6xl"}>
        <TicketView id={id} />
      </div>
    );
  }
  let loaded;
  try {
    loaded = await loadRecord(entityName, id);
  } catch (error) {
    // The proxy already sends a visitor without a complete session away; this covers an expired one.
    if (error instanceof Unauthenticated) redirect(redirectPathFor(error.reason));
    throw error;
  }
  // No such record for this user, or no full page for the entity: both look the same.
  if (!loaded) {
    // A restricted Cuenta the caller may not view is not there for them: its record answers "Sin acceso" on the tabs that would show figures
    // (accounting design §5.13), without a word about the account. The answer is the same for an id that does not exist.
    if (entityName === "accounting.account" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return <RestrictedAccount id={id} full={full} />;
    notFound();
  }
  const { entity, record, title, defs, contacts, modes, canSave, can, requiredTags, attachments, verifications, contributed, form, lifecycle: lc } = loaded;
  const t = await getTranslations();
  const locale = await getLocale();

  // A comprobante has wide lines: it takes the whole width of the page; the other records keep a readable column.
  const wrapperClass = form.kind === "entry" || full ? "w-full" : "mx-auto w-full max-w-6xl";
  const datos: Omit<RecordTab, "id"> = { content: <RecordForm entity={entity.id} record={record} modes={modes} readOnly={!canSave} form={form} /> };
  const newTitle = t("grid.record_title.new", { entity: t(entity.nounKey) });
  // The action bar of a maestro or documento (Task 15): its buttons, tools and footer facts.
  const frameLifecycle = lc
    ? {
        entityType: lc.entityType,
        status: lc.status,
        // A new comprobante takes Requiere aprobación from the accounting settings (manual entries), as its create process writes it.
        flags: form.kind === "entry" && !record ? { ...lc.flags, requiresApproval: form.settings.requireApprovalOnManual } : lc.flags,
        rights: lc.rights,
        tools: lc.tools,
        updatedAt: lc.updatedAt,
        createdAt: lc.createdAt,
        createdBy: lc.createdBy,
        updatedBy: lc.updatedBy,
        recipients: lc.recipients,
        noun: t(entity.nounKey),
        listHref: lc.listHref,
        reverse: form.kind === "entry" && record?.status === "posted" && (record.extra as Record<string, unknown> | null)?.reversed !== true && form.can.reverse === true,
      }
    : null;
  if (!record) {
    // A record that does not exist yet has only its data; files, contacts and extra data need its id.
    return (
      <div className={wrapperClass}>
        <AppRecordFrame entity={entity.id} recordId={null} newTitle={newTitle} title={newTitle} tabs={[{ id: "datos", ...datos }]} labels={recordLabels(t)} lifecycle={frameLifecycle} />
      </div>
    );
  }

  const extra = (record.extra as Record<string, unknown> | null) ?? {};
  const extraFree = (record.extra_free as { name: string; value: string }[] | null) ?? [];
  const counts = extraTabCounts(defs, extra, extraFree);
  // What the picture suggestion is made from: the product's description, unit and category.
  const category = form.kind === "product" ? form.categories.find((c) => c.id === record.category_id) : undefined;
  const hints = {
    description: String(record[entity.titleField] ?? ""),
    ...(typeof record.uom_code === "string" ? { uom: record.uom_code } : {}),
    ...(category ? { category: category.name } : {}),
  };
  const content: Record<string, Omit<RecordTab, "id">> = {
    datos,
    contactos: { count: contacts.length, content: <ContactsPanel partyId={record.id} contacts={contacts} can={can} verifications={verifications} /> },
    fotos: { content: <PhotosPanel entity={entity.id} recordId={record.id} can={can} hints={hints} /> },
    extra: { ...counts, content: <ExtraPanel entity={entity.id} recordId={record.id} defs={defs} extra={extra} extraFree={extraFree} canEdit={can.extra} /> },
    archivos: { content: <FilesPanel entity={entity.id} recordId={record.id} requiredTags={requiredTags} attachments={attachments} can={can} /> },
  };

  // A comprobante also tells where it came from (accounting design §8).
  if (form.kind === "entry" && form.origin) {
    const o = form.origin;
    content.origen = {
      content: <OriginTab origin={o.origin} source={o.source} event={o.event} rule={o.rule} reversalOf={o.reversalOf} reversedBy={o.reversedBy} chainId={o.chainId} timeline={o.timeline} />,
    };
  }

  // The Saldos, Movimientos, Seguridad, Resumen, Cierre, Líneas… of an accounting master (accounting design §8).
  if (loaded.accounting) Object.assign(content, await accountingContent(entity.id, record, loaded.accounting, canSave));

  // Versiones of a documento (D18: masked for the viewer by the server) and Acceso for an admin (Task 15).
  if (lc?.snapshots) content.versiones = { count: lc.snapshots.length, content: <VersionsTab snapshots={lc.snapshots} labels={lc.versionLabels} masked={MASKED} /> };
  if (lc?.access) content.acceso = { content: <AccessPanel entity={entity.id} recordId={record.id} entityType={lc.entityType} grants={lc.access.grants} options={lc.access.options} /> };

  // Tabs other modules' manifests add (rule 4): each carries its own name, and the grid ones their row count.
  for (const tab of contributed) {
    content[tab.id] = { label: t.has(tab.label) ? t(tab.label) : tab.label, ...(tab.count ? { count: tab.count } : {}), content: <ContributedTab entityId={entity.id} recordId={record.id} tab={tab} /> };
  }

  return (
    <div className={wrapperClass}>
      <AppRecordFrame
        entity={entity.id}
        recordId={record.id}
        canDuplicate={can.duplicate}
        newTitle={newTitle}
        title={entity.id === "accounting.account" && typeof record.code === "string" && typeof record.name === "string" ? t("accounting.record.account_title", { code: record.code, name: record.name }) : title ? formatLabel(title, locale) : untitledRecordTitle({ status: lc?.status, seq: record.seq, isEntry: form.kind === "entry", draftTitle: t("accounting.entry.draft_title"), idLabel: t("common.record.ids.id"), fallback: record.id })}
        seq={record.seq === null || record.seq === undefined ? null : Number(record.seq)}
        uuid={record.id}
        number={typeof record.number === "string" && record.number ? record.number : null}
        reference={typeof record.reference === "string" && record.reference ? record.reference : null}
        {...(lc ? { chip: <Pill tone={STATUS_TONE[lc.status] ?? "gray"}>{t(`common.record.status.${lc.status}`)}</Pill> } : {})}
        lifecycle={frameLifecycle}
        deepLinkHref={`${recordHref(entity.id, record.id)}${FULL_VIEW}`}
        tabs={recordTabIds(entity.id, contributed.map((tab) => tab.id))
          .filter((tabId) => content[tabId] !== undefined)
          .map((tabId): RecordTab => ({ id: tabId, ...content[tabId]! }))}
        labels={recordLabels(t)}
        status={<RecordStatus record={record} t={t} />}
      />
    </div>
  );
}

async function RestrictedAccount({ id, full }: { id: string; full: boolean }) {
  const t = await getTranslations();
  const denied = { content: <NoAccess text={t("accounting.record.no_access")} /> };
  return (
    <div className={full ? "w-full" : "mx-auto w-full max-w-6xl"}>
      <AppRecordFrame
        entity="accounting.account"
        recordId={id}
        newTitle={t("grid.record_title.new", { entity: t("nav.create.accounting.account") })}
        title={t("accounting.record.restricted_account")}
        seq="masked"
        uuid={id}
        deepLinkHref={`${recordHref("accounting.account", id)}${FULL_VIEW}`}
        status={
          <span data-testid="record-status" className="erp-record__status">
            <span className="erp-pill erp-pill--gray">{t("accounting.record.no_access")}</span>
          </span>
        }
        tabs={[
          { id: "saldos", ...denied },
          { id: "movimientos", ...denied },
        ]}
        labels={recordLabels(t)}
      />
    </div>
  );
}

/** The frame's copy from the catalogue. */
function recordLabels(t: Awaited<ReturnType<typeof getTranslations>>) {
  return {
    tabs: {
      datos: t("common.record.tabs.datos"),
      contactos: t("common.record.tabs.contactos"),
      fotos: t("common.record.tabs.fotos"),
      mensajes: t("common.record.tabs.mensajes"),
      extra: t("common.record.tabs.extra"),
      archivos: t("common.record.tabs.archivos"),
      origen: t("common.record.tabs.origen"),
      saldos: t("common.record.tabs.saldos"),
      movimientos: t("common.record.tabs.movimientos"),
      seguridad: t("common.record.tabs.seguridad"),
      resultados: t("common.record.tabs.resultados"),
      resumen: t("common.record.tabs.resumen"),
      comprobantes: t("common.record.tabs.comprobantes"),
      cierre: t("common.record.tabs.cierre"),
      lineas: t("common.record.tabs.lineas"),
      probar: t("common.record.tabs.probar"),
      historial: t("common.record.tabs.historial"),
      versiones: t("common.record.tabs.versiones"),
      acceso: t("common.record.tabs.acceso"),
    },
    number: t("common.record.number"),
    docNumber: t("common.record.ids.number"),
    reference: t("common.record.ids.reference"),
    copy: t.raw("common.record.ids.copy") as string,
    uuid: t("common.record.uuid"),
    assignedOnCreate: t("common.record.assigned_on_create"),
    openInNewTab: t("common.record.open_in_new_tab"),
    pending: t("common.record.pending"),
    duplicate: t("common.record.duplicate"),
    // The frame puts the source's name, as a link, where `{name}` is.
    copyOf: t.raw("common.record.copy_of") as string,
    copyNote: t("common.record.copy_note"),
  };
}

/** The state chip's tone by status (prototype `chip`). */
const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "gray" | "info"> = { draft: "gray", saved: "info", pending: "warn", rejected: "danger", approved: "ok", posted: "ok", voided: "danger" };

export default function RecordPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  // The session cookie, the route params and the query are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <RecordView params={params} searchParams={searchParams} />
    </Suspense>
  );
}
