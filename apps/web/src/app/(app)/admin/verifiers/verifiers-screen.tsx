"use client";

import { useTranslations } from "next-intl";
import type { VerifiersData } from "@/lib/admin/load";
import { StepUpDock, useAdminAction } from "../_components/use-admin-action";

const KINDS = ["email", "phone", "document"] as const;

/** Verificadores (design §5.16): the provider of each kind, or none (requests stay queued until one is chosen). */
export function VerifiersScreen({ data }: { data: VerifiersData }) {
  const t = useTranslations();
  const { perform, prompt, status, busy } = useAdminAction();
  // The candidates the design names per kind (§5.16), from the catalogue ("A|B|C"), shown as a hint; the select offers
  // the providers whose adapter is registered (kernel.verifier.set accepts only those).
  const candidates = (kind: (typeof KINDS)[number]) => t(`common.admin.verifiers.providers.${kind}`).split("|");
  return (
    <section className="erp-card">
      <div className="erp-admin__head">
        <h2>{t("common.admin.verifiers.title")}</h2>
        <span className="erp-small erp-muted">{t("common.admin.verifiers.hint")}</span>
      </div>
      {status && <div style={{ padding: "8px 14px" }}>{status}</div>}
      {KINDS.map((kind) => (
        <div key={kind} className="erp-admin__row">
          <div className="erp-grow">
            <b>{t(`common.admin.verifiers.kind.${kind}`)}</b>
            <div className="erp-small erp-muted">{t("common.admin.verifiers.candidates", { list: candidates(kind).join(", ") })}</div>
          </div>
          <select
            aria-label={t(`common.admin.verifiers.kind.${kind}`)}
            disabled={busy}
            value={data.providers[kind] ?? ""}
            onChange={(e) => void perform("kernel.verifier.set", { kind, provider: e.target.value || null })}
          >
            <option value="">{t("common.admin.verifiers.none")}</option>
            {[...new Set([...data.available, ...(data.providers[kind] ? [data.providers[kind]!] : [])])].map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        </div>
      ))}
      <StepUpDock prompt={prompt} />
    </section>
  );
}
