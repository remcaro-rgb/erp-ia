import { getTranslations } from "next-intl/server";
import { Pill, RecordLink, shortId } from "@erp/ui";
import type { LoadedRelated } from "@/lib/records/related-load";

// The tab «Documentos relacionados» (design §22.27, R31-8): the documents upstream (Origen) and downstream (Derivados) of this one, each a link
// to its page (rule 21), voided ones struck through with «Anulado», and what the viewer cannot see as a count. Drawn from the trail's result
// alone: the frame names no module (rule 4); the kind of document is the entity's own name from the catalogue.

export async function RelatedTab({ related }: { related: LoadedRelated }) {
  const t = await getTranslations("common.record.related");
  const tt = await getTranslations();
  const { model, nouns } = related;
  const kindName = (kind: string) => (t.has(`kind.${kind}`) ? t(`kind.${kind}`) : kind);
  const sections = (["up", "down"] as const).map((direction) => ({ direction, entries: model.entries.filter((e) => e.direction === direction) })).filter((s) => s.entries.length > 0);
  return (
    <div className="flex flex-col gap-4" data-testid="related-tab">
      {model.entries.length === 0 && model.hidden === 0 ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}
      {sections.map(({ direction, entries }) => (
        <section key={direction} aria-labelledby={`related-${direction}`}>
          <h3 id={`related-${direction}`} className="mb-1 text-sm font-semibold">
            {t(direction)}
          </h3>
          <ul className="flex flex-col gap-1">
            {entries.map((entry) => (
              <li key={`${direction}:${entry.id}`} data-testid="related-entry" data-voided={entry.voided ? "true" : "false"} className="flex flex-wrap items-center gap-2 text-sm" style={{ paddingInlineStart: `${entry.indent * 20}px` }}>
                <span className="text-muted-foreground">{nouns[entry.entity] ? tt(nouns[entry.entity]!) : entry.entity}</span>
                <span className={entry.voided ? "line-through [&_a]:line-through" : undefined}>
                  <RecordLink entity={entry.entity} id={entry.id} label={entry.label ?? shortId(entry.id)} mono />
                </span>
                {entry.kind ? <span className="text-xs text-muted-foreground">{kindName(entry.kind)}</span> : null}
                {entry.voided ? <Pill tone="danger">{t("voided")}</Pill> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {model.hidden > 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="related-hidden">
          {t("hidden", { count: model.hidden })}
        </p>
      ) : null}
      {model.truncated ? (
        <p className="text-sm text-muted-foreground" data-testid="related-truncated">
          {t("truncated", { count: model.shown })}
        </p>
      ) : null}
    </div>
  );
}
