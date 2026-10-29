import type { getTranslations } from "next-intl/server";
import { dianPill } from "@erp/ui";

type Translate = Awaited<ReturnType<typeof getTranslations>>;

/**
 * The footer's status (rule 21): whether the record can go on an invoice (design §5.17: DIAN complete, required files
 * present, active) and its DIAN status in words (`complete` → "DIAN: completo", `missing: 4` → "DIAN: faltan 4 datos").
 * The page reloads after a file is added or removed, so this follows the files.
 */
export function RecordStatus({ record, t }: { record: Record<string, unknown>; t: Translate }) {
  const ready = typeof record.invoice_ready === "boolean" ? record.invoice_ready : null;
  const dian = dianPill(record.dian_status);
  if (ready === null && dian === null) return null;
  return (
    <span data-testid="record-status" className="erp-record__status">
      {ready !== null && <span className={`erp-pill erp-pill--${ready ? "ok" : "danger"}`}>{t(ready ? "common.forms.invoice_ok" : "common.forms.invoice_no")}</span>}
      {dian !== null && (
        <>
          {" "}
          <span className="erp-pill erp-pill--gray">{t(`common.record.dian.${dian.key}`, { count: dian.count })}</span>
        </>
      )}
    </span>
  );
}
