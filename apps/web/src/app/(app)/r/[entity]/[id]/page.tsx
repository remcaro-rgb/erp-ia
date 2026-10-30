import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { getTranslations } from "next-intl/server";
import { redirectPathFor, Unauthenticated } from "@/lib/auth/claims";
import { extraTabCounts, recordHref, recordTabIds, type RecordTab } from "@erp/ui";
import { loadRecord } from "@/lib/records/load";
import { ContactsPanel } from "./contacts-panel";
import { ContributedTab } from "./contributed-tab";
import { ExtraPanel } from "./extra-panel";
import { FilesPanel } from "./files-panel";
import { PhotosPanel } from "./photos-panel";
import { RecordForm } from "./record-form";
import { AppRecordFrame } from "./record-frame";
import { RecordStatus } from "./record-status";
import { TicketView } from "../../../support/ticket-view";

// Full-page record (design §5.16): /r/<entity>/<id> renders the record frame with the entity's Datos form (party,
// product, category) and the Contactos, Fotos, Datos adicionales and Archivos tabs; /r/<entity>/new is the empty form,
// or the copy "Duplicar" opened it with (rule 37).

type Params = Promise<{ entity: string; id: string }>;

async function RecordView({ params }: { params: Params }) {
  // The session is verified with Supabase Auth, which reads the clock: keep it out of prerendering.
  await connection();
  const { entity: entityId, id } = await params;
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
      <div className="mx-auto w-full max-w-6xl">
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
  if (!loaded) notFound();
  const { entity, record, defs, contacts, modes, canSave, can, requiredTags, attachments, verifications, contributed, form } = loaded;
  const t = await getTranslations();

  const datos: Omit<RecordTab, "id"> = { content: <RecordForm entity={entity.id} record={record} modes={modes} readOnly={!canSave} form={form} /> };
  const newTitle = t("grid.record_title.new", { entity: t(entity.nounKey) });
  if (!record) {
    // A record that does not exist yet has only its data; files, contacts and extra data need its id.
    return (
      <div className="mx-auto w-full max-w-6xl">
        <AppRecordFrame entity={entity.id} recordId={null} newTitle={newTitle} title={newTitle} tabs={[{ id: "datos", ...datos }]} labels={recordLabels(t)} />
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

  // Tabs other modules' manifests add (rule 4): each carries its own name, and the grid ones their row count.
  for (const tab of contributed) {
    content[tab.id] = { label: t.has(tab.label) ? t(tab.label) : tab.label, ...(tab.count ? { count: tab.count } : {}), content: <ContributedTab entityId={entity.id} recordId={record.id} tab={tab} /> };
  }

  return (
    <div className="mx-auto w-full max-w-6xl">
      <AppRecordFrame
        entity={entity.id}
        recordId={record.id}
        canDuplicate={can.duplicate}
        newTitle={newTitle}
        title={String(record[entity.titleField] ?? record.id)}
        seq={record.seq === null || record.seq === undefined ? null : Number(record.seq)}
        uuid={record.id}
        deepLinkHref={recordHref(entity.id, record.id)}
        tabs={recordTabIds(entity.id, contributed.map((tab) => tab.id)).map((tabId): RecordTab => ({ id: tabId, ...content[tabId]! }))}
        labels={recordLabels(t)}
        status={<RecordStatus record={record} t={t} />}
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
    },
    number: t("common.record.number"),
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

export default function RecordPage({ params }: { params: Params }) {
  // The session cookie and the route params are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <RecordView params={params} />
    </Suspense>
  );
}
