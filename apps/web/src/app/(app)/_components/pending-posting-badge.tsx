import Link from "next/link";
import { useTranslations } from "next-intl";
import { Pill } from "@erp/ui";
import type { PendingPosting } from "@/lib/accounting/pending-state";

/**
 * «Pendiente de contabilizar» in the record frame of a documento whose entry is not in the ledger yet (Task 33, R33-8): `queued` waits for the
 * consumer, `parked` waits for the accounting module (switched off, or never bought: the reason is said), and `failed` is in the retry queue
 * and links to Pendientes; `dead` was dead-lettered and links to Admin › Módulos. It goes by itself once the entry exists.
 */
export function PendingPostingBadge({ pending }: { pending: PendingPosting }) {
  const t = useTranslations("accounting.pending");
  if (pending.state === "failed") {
    return (
      <Link href="/accounting/posting?tab=pending" data-testid="pending-posting" data-state="failed" className="erp-pill erp-pill--danger">
        {t("failed")}
      </Link>
    );
  }
  if (pending.state === "dead") {
    return (
      <Link href="/admin/modules" data-testid="pending-posting" data-state="dead" className="erp-pill erp-pill--danger">
        {t("dead")}
      </Link>
    );
  }
  const parked = pending.state === "parked";
  return (
    <span data-testid="pending-posting" data-state={pending.state} title={parked ? undefined : t("queued_hint")}>
      <Pill tone="warn">{parked ? t("parked") : t("queued")}</Pill>
      {parked && pending.reason ? <span className="erp-small erp-muted"> · {t(pending.reason === "accounting_disabled" ? "reason_accounting_disabled" : "reason_not_entitled")}</span> : null}
    </span>
  );
}
