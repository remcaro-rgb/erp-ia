import { Suspense } from "react";
import { notFound } from "next/navigation";
import { AttachmentsPanel, ContactsTab, ExtraDataTab, PhotosTab, RecordFrame, extraTabCounts, recordHref, recordTabIds, type RecordTab } from "@erp/ui";
import { datosRows } from "@/lib/records/entities";
import { loadRecord } from "@/lib/records/load";

// Full-page record (design §5.16): /r/<entity>/<id> renders the same frame as the modal, so the open-in-a-new-tab
// button of any record lands here. Tasks 12-13 put the real forms in the Datos tab; the other tabs are wired already.

type Params = Promise<{ entity: string; id: string }>;

async function RecordView({ params }: { params: Params }) {
  const { entity: entityId, id } = await params;
  const loaded = await loadRecord(decodeURIComponent(entityId), id);
  // No session, no such record for this user, or no full page for the entity: all look the same. Task 10 sends
  // an anonymous visitor to the sign-in page instead.
  if (!loaded) notFound();
  const { entity, record, defs, contacts } = loaded;

  const extra = (record.extra as Record<string, unknown> | null) ?? {};
  const extraFree = (record.extra_free as { name: string; value: string }[] | null) ?? [];
  const counts = extraTabCounts(defs, extra, extraFree);

  const content: Record<string, Omit<RecordTab, "id">> = {
    datos: {
      content: (
        <dl className="erp-record__facts">
          {datosRows(record).map(([name, value]) => (
            <div key={name}>
              <dt>{name}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    contactos: { count: contacts.length, content: <ContactsTab contacts={contacts} readOnly /> },
    fotos: { content: <PhotosTab entity={entity.id} recordId={id} /> },
    extra: { ...counts, content: <ExtraDataTab defs={defs} extra={extra} extraFree={extraFree} readOnly /> },
    archivos: { content: <AttachmentsPanel entity={entity.id} recordId={id} /> },
  };

  return (
    <main className="mx-auto w-full max-w-4xl p-4">
      <RecordFrame
        title={String(record[entity.titleField] ?? id)}
        seq={record.seq === null || record.seq === undefined ? null : Number(record.seq)}
        uuid={id}
        deepLinkHref={recordHref(entity.id, id)}
        tabs={recordTabIds(entity.id).map((tabId): RecordTab => ({ id: tabId, ...content[tabId]! }))}
        status={typeof record.dian_status === "string" ? <span>{record.dian_status}</span> : undefined}
      />
    </main>
  );
}

export default function RecordPage({ params }: { params: Params }) {
  // The session cookie and the route params are request data: read them inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <RecordView params={params} />
    </Suspense>
  );
}
