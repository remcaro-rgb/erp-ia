"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { paramsFromSearch, RecordLink } from "@erp/ui";
import type { LotTraceHeading as HeadingData } from "@/lib/inventory/lot-trace-report";

// The heading of «Trazabilidad de lotes» (plan 2B.2 Task 28.5, rule 21): the lot or serial the report runs on, as a link to its record when
// the caller may open it. It follows the bar's parameters, which the report keeps in the address (`?p=`).

export function LotTraceHeading({ data }: { data: HeadingData }) {
  const t = useTranslations("report.lot_trace");
  const params = paramsFromSearch(useSearchParams().toString());
  const lotId = typeof params.lotId === "string" ? params.lotId : null;
  const serialId = typeof params.serialId === "string" ? params.serialId : null;
  const subject = lotId ? data.lots[lotId] : serialId ? data.serials[serialId] : undefined;
  if (!subject) return null;
  const entity = lotId ? "inventory.lot" : "inventory.serial";
  const id = (lotId ?? serialId)!;
  const linkable = lotId ? data.lotLinkable : data.serialLinkable;
  return (
    <h2 className="text-base font-semibold" data-testid="lot-trace-subject">
      {t(lotId ? "subject_lot" : "subject_serial")}{" "}
      {linkable ? <RecordLink entity={entity} id={id} label={subject.code} mono /> : <span className="erp-mono">{subject.code}</span>}
      {subject.product && <span className="erp-muted"> · {subject.product}</span>}
    </h2>
  );
}
