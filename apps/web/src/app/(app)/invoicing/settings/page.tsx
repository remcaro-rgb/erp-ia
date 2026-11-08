import { Suspense } from "react";
import { getTranslations } from "next-intl/server";
import { withClaims } from "@erp/kernel";
import { callerIsCompanyAdmin } from "@/lib/admin/company-admin";
import { processDeps } from "@/lib/server/runtime";
import { consultSettings, settingsCaller } from "../../_components/sales/settings-load";
import type { ChecklistConsult } from "@/lib/invoicing/checklist-view";
import { InvoicingSettingsForm, type NumberingRow, type SettingsView } from "./settings-form";

// Parámetros › Facturación electrónica (plan 2B Task 19; prototype 2B /invoicing/settings): how invoices are created, the DIAN connection
// (habilitación / producción, the progress of the DIAN verification checklist and its confirmation (the checklist is its own screen, Task 35), the software and the issuer profile), the numbering (the DIAN resolution
// of invoices and the rows of the notes, core.document_sequence.register), the signing certificate and the software PIN (secret store only:
// the page shows what the certificate says of itself, never its content) and «Reintentar todos». Only the company's administrators open it;
// every save asks for the verification code (step-up) except «Reintentar todos».
async function Settings() {
  const caller = await settingsCaller();
  const t = await getTranslations();
  const deps = processDeps();
  const loaded = await withClaims(deps.sql, caller.claims, async (tx) => {
    if (!(await callerIsCompanyAdmin(tx))) return null;
    const sequences = await tx<{ id: string; document_type: string; prefix: string; next_number: string | number; resolution: Record<string, unknown> | null }[]>`
      select id, document_type, prefix, next_number, resolution from core.v_document_sequences
      where document_type in ('invoice', 'credit_note', 'debit_note') order by document_type, prefix`;
    const [pending] = await tx<{ not_configured: number; failed: number }[]>`
      select count(*) filter (where status = 'not_configured')::int as not_configured, count(*) filter (where status = 'failed')::int as failed
      from invoicing.v_einvoice_submissions`;
    const [company] = await tx<{ tax_id: string | null }[]>`select tax_id from kernel.v_companies where id = kernel.current_company_id()`;
    return { sequences, pending: pending ?? { not_configured: 0, failed: 0 }, taxId: company?.tax_id ?? null };
  });
  if (!loaded) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t("invoicing.settings_page.admins_only")}
      </div>
    );
  }
  const consulted = await consultSettings(caller, "invoicing.settings.consult");
  if ("denied" in consulted) {
    return (
      <div role="alert" className="erp-dian erp-dian--bad">
        {t(`grid.denied.${consulted.denied}`)}
      </div>
    );
  }
  const row = consulted.row;
  // Task 35: the checklist's progress and the items added since the confirmation (the settings consult carries the effective flag).
  // An administrator whose role matrix lacks the checklist's consult still sees the rest of the Parámetros (the card then has no checklist line).
  const listed = await consultSettings(caller, "invoicing.dian_checklist.consult");
  const checklist = "denied" in listed ? null : (listed.row as unknown as ChecklistConsult);
  const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const when = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : text(v));
  const settings: SettingsView = {
    invoiceCreation: text(row.invoice_creation) ?? "manual",
    dianEnvironment: text(row.dian_environment) ?? "habilitacion",
    creditDays: Number(row.credit_days ?? 30),
    checklist: checklist
      ? {
          confirmed: row.dian_defaults_confirmed === true,
          done: Number(checklist.progress.done),
          total: Number(checklist.progress.total),
          newCount: checklist.items.filter((i) => i.isNew).length,
        }
      : null,
    softwareId: text(row.software_id),
    softwareProviderTaxId: text(row.software_provider_tax_id),
    testSetId: text(row.test_set_id),
    issuerTaxResponsibilities: Array.isArray(row.issuer_tax_responsibilities) ? row.issuer_tax_responsibilities.map(String) : [],
    issuerTaxScheme: text(row.issuer_tax_scheme) ?? "01",
    issuerDepartmentCode: text(row.issuer_department_code),
    issuerMunicipalityCode: text(row.issuer_municipality_code),
    certificate: text(row.certificate_serial)
      ? {
          subject: text(row.certificate_subject) ?? "",
          taxId: text(row.certificate_tax_id) ?? "",
          issuer: text(row.certificate_issuer) ?? "",
          serial: text(row.certificate_serial) ?? "",
          validTo: when(row.certificate_valid_to),
          uploadedAt: when(row.certificate_uploaded_at),
          status: text(row.certificate_status) ?? "unknown",
        }
      : null,
    pinSetAt: when(row.software_pin_set_at),
  };
  // The technical key signs every CUFE: the page shows only its last characters.
  const numbering: NumberingRow[] = loaded.sequences.map((s) => {
    const r = s.resolution;
    return {
      id: s.id,
      documentType: s.document_type,
      prefix: s.prefix,
      nextNumber: Number(s.next_number),
      resolution: r
        ? {
            number: String(r.number ?? ""), from: Number(r.from), to: Number(r.to), validFrom: String(r.validFrom ?? ""), validTo: String(r.validTo ?? ""),
            technicalKeyEnding: typeof r.technicalKeyEnding === "string" ? r.technicalKeyEnding : "",
          }
        : null,
    };
  });
  return <InvoicingSettingsForm settings={settings} numbering={numbering} pending={{ notConfigured: loaded.pending.not_configured, failed: loaded.pending.failed }} companyTaxId={loaded.taxId} />;
}

export default function InvoicingSettingsPage() {
  // The session cookie is request data: read it inside Suspense (cache components).
  return (
    <Suspense fallback={null}>
      <Settings />
    </Suspense>
  );
}
