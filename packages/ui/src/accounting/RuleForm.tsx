"use client";

import { useTranslations } from "next-intl";
import { Pill } from "../grid/GridCell";
import { MasterForm, type MasterFormProps } from "./MasterForm";

// The Datos tab of a Regla contable (accounting design §8): event, Fuente, priority and active, with the badge that tells whether the
// company changed the rule the module shipped. Saving is `posting_rule.update`, a step-up process.

export type RuleFormProps = Omit<MasterFormProps, "kind" | "processes"> & { isDefault: boolean; isModified: boolean; stale?: boolean; staleDays?: number };

export function RuleForm({ isDefault, isModified, stale = false, staleDays = 30, ...props }: RuleFormProps) {
  const t = useTranslations("accounting.record.rule");
  return (
    <div className="erp-stack">
      <p>
        <Pill tone={isModified ? "warn" : "gray"}>{isModified ? t("modified") : isDefault ? t("default") : t("own")}</Pill>
        {stale && (
          <>
            {" "}
            <Pill tone="warn">{t("stale", { days: staleDays })}</Pill>
          </>
        )}
      </p>
      <MasterForm kind="rule" processes={{ create: "accounting.posting_rule.create", update: "accounting.posting_rule.update" }} {...props} />
    </div>
  );
}
