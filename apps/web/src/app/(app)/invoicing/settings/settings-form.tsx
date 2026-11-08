"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAction } from "./use-action";

// Parámetros › Facturación electrónica (plan 2B Task 19). One card per concern, each saved by its own button through its own process; every
// save but «Reintentar todos» asks for the verification code (StepUpPrompt) and sends the same input again with the token. The certificate
// and the PIN leave the browser only to their process: the form clears them once saved and never shows them back.

export interface SettingsView {
  invoiceCreation: string;
  dianEnvironment: string;
  creditDays: number;
  /** The DIAN verification checklist (Task 35): the confirmation as it counts (effective), the ticks and the items added since it was made. */
  checklist: { confirmed: boolean; done: number; total: number; newCount: number } | null;
  softwareId: string | null;
  softwareProviderTaxId: string | null;
  testSetId: string | null;
  issuerTaxResponsibilities: string[];
  issuerTaxScheme: string;
  issuerDepartmentCode: string | null;
  issuerMunicipalityCode: string | null;
  certificate: { subject: string; taxId: string; issuer: string; serial: string; validTo: string | null; uploadedAt: string | null; status: string } | null;
  pinSetAt: string | null;
}

export interface NumberingRow {
  id: string;
  documentType: string;
  prefix: string;
  nextNumber: number;
  resolution: { number: string; from: number; to: number; validFrom: string; validTo: string; technicalKeyEnding: string } | null;
}

function Card({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="erp-sec" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {hint && <p className="erp-small erp-muted">{hint}</p>}
      {children}
    </section>
  );
}

function Field({ id, label, children, hint }: { id: string; label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="erp-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="erp-small erp-muted">{hint}</span>}
    </div>
  );
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

export function InvoicingSettingsForm({ settings, numbering, pending, companyTaxId }: {
  settings: SettingsView;
  numbering: NumberingRow[];
  pending: { notConfigured: number; failed: number };
  companyTaxId: string | null;
}) {
  const t = useTranslations("invoicing.settings_page");
  const tv = useTranslations("invoicing.values");
  const f = useId();

  // Creación de facturas
  const [mode, setMode] = useState(settings.invoiceCreation);
  const [creditDays, setCreditDays] = useState(String(settings.creditDays));
  const creation = useAction("settings", () => t("saved"));

  // Conexión DIAN
  const [environment, setEnvironment] = useState(settings.dianEnvironment);
  const [softwareId, setSoftwareId] = useState(settings.softwareId ?? "");
  const [providerTaxId, setProviderTaxId] = useState(settings.softwareProviderTaxId ?? "");
  const [testSetId, setTestSetId] = useState(settings.testSetId ?? "");
  const [responsibilities, setResponsibilities] = useState(settings.issuerTaxResponsibilities.join(", "));
  const [taxScheme, setTaxScheme] = useState(settings.issuerTaxScheme);
  const [department, setDepartment] = useState(settings.issuerDepartmentCode ?? "");
  const [municipality, setMunicipality] = useState(settings.issuerMunicipalityCode ?? "");
  const connection = useAction("settings", () => t("saved"));

  // Resolución y numeración
  const [docType, setDocType] = useState("invoice");
  const [prefix, setPrefix] = useState("");
  const [resNumber, setResNumber] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [technicalKey, setTechnicalKey] = useState("");
  const [nextNumber, setNextNumber] = useState("");
  const sequence = useAction("sequence", () => t("numbering_saved"));

  // Certificado y PIN
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [password, setPassword] = useState("");
  const certificate = useAction("certificate", () => t("certificate_saved"));
  const [pin, setPin] = useState("");
  const pinAction = useAction("pin", () => t("pin_saved"));

  // Reintentar todos
  const resubmit = useAction("resubmit", (data) => {
    const count = Array.isArray(data.requeued) ? data.requeued.length : 0;
    return count === 0 ? t("resubmit_none") : t("resubmit_done", { count });
  });

  const saveCreation = () => void creation.run({ invoiceCreation: mode, creditDays: Number(creditDays) });
  const saveConnection = () =>
    void connection.run({
      dianEnvironment: environment,
      softwareId: orNull(softwareId),
      softwareProviderTaxId: orNull(providerTaxId),
      testSetId: orNull(testSetId),
      issuerTaxResponsibilities: responsibilities.split(",").map((r) => r.trim()).filter(Boolean),
      issuerTaxScheme: taxScheme,
      issuerDepartmentCode: orNull(department),
      issuerMunicipalityCode: orNull(municipality),
    });
  const saveSequence = () => {
    const input: Record<string, unknown> = { documentType: docType, prefix: prefix.trim().toUpperCase() };
    if (nextNumber.trim()) input.nextNumber = Number(nextNumber);
    if (docType === "invoice") {
      input.resolution = { number: resNumber.trim(), from: Number(from), to: Number(to), validFrom, validTo, technicalKey: technicalKey.trim() };
    }
    void sequence.run(input, () => {
      setTechnicalKey("");
      setNextNumber("");
    });
  };
  const uploadCertificate = async () => {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    void certificate.run({ file: btoa(binary), password }, () => {
      setPassword("");
      setFile(null);
      setFileKey((k) => k + 1);
    });
  };
  const savePin = () => void pinAction.run({ pin }, () => setPin(""));

  const typeLabel = (type: string) => t(`document_types.${type}` as never);
  const cert = settings.certificate;

  return (
    <div className="erp-form mx-auto w-full max-w-4xl">
      <div>
        <h1 className="text-xl font-semibold">{t("title")}</h1>
        <p className="erp-small erp-muted">{t("subtitle")}</p>
      </div>

      <Card title={t("creation_title")} hint={t("creation_hint")}>
        <fieldset className="erp-field" disabled={creation.busy}>
          <legend className="erp-small erp-muted">{t("creation_title")}</legend>
          {(["manual", "on_delivery", "on_order_confirmation"] as const).map((m) => (
            <label key={m} className="erp-row">
              <input type="radio" name={`${f}-mode`} value={m} checked={mode === m} onChange={() => setMode(m)} />
              <span>
                <b>{tv(`invoice_creation.${m}`)}</b>
                <span className="erp-small erp-muted"> · {t(`creation_${m}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="erp-form2">
          <Field id={`${f}-credit`} label={t("credit_days")}>
            <input id={`${f}-credit`} type="number" min={0} max={365} value={creditDays} onChange={(e) => setCreditDays(e.target.value)} />
          </Field>
        </div>
        {creation.feedback}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn erp-btn--primary" disabled={creation.busy} onClick={saveCreation}>{t("save_creation")}</button>
        </div>
      </Card>

      <Card title={t("connection_title")} hint={t("connection_hint")}>
        <div className="erp-form2">
          <Field id={`${f}-env`} label={t("environment")}>
            <select id={`${f}-env`} value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="habilitacion">{tv("dian_environment.habilitacion")}</option>
              <option value="produccion">{tv("dian_environment.produccion")}</option>
            </select>
          </Field>
          <Field id={`${f}-software`} label={t("software_id")}>
            <input id={`${f}-software`} value={softwareId} onChange={(e) => setSoftwareId(e.target.value)} autoComplete="off" />
          </Field>
          <Field id={`${f}-provider`} label={t("software_provider_tax_id")} hint={t("software_provider_tax_id_hint")}>
            <input id={`${f}-provider`} value={providerTaxId} inputMode="numeric" onChange={(e) => setProviderTaxId(e.target.value)} autoComplete="off" />
          </Field>
          <Field id={`${f}-testset`} label={t("test_set_id")}>
            <input id={`${f}-testset`} value={testSetId} onChange={(e) => setTestSetId(e.target.value)} autoComplete="off" />
          </Field>
          <Field id={`${f}-resp`} label={t("issuer_responsibilities")} hint={t("issuer_responsibilities_hint")}>
            <input id={`${f}-resp`} value={responsibilities} onChange={(e) => setResponsibilities(e.target.value)} autoComplete="off" />
          </Field>
          <Field id={`${f}-scheme`} label={t("issuer_tax_scheme")}>
            <select id={`${f}-scheme`} value={taxScheme} onChange={(e) => setTaxScheme(e.target.value)}>
              {(["01", "04", "ZA", "ZZ"] as const).map((code) => (
                <option key={code} value={code}>{t(`tax_schemes.scheme_${code.toLowerCase()}` as never)}</option>
              ))}
            </select>
          </Field>
          <Field id={`${f}-dept`} label={t("issuer_department")}>
            <input id={`${f}-dept`} value={department} inputMode="numeric" maxLength={2} onChange={(e) => setDepartment(e.target.value)} autoComplete="off" />
          </Field>
          <Field id={`${f}-muni`} label={t("issuer_municipality")}>
            <input id={`${f}-muni`} value={municipality} inputMode="numeric" maxLength={5} onChange={(e) => setMunicipality(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        {/* Task 35: the DIAN defaults are confirmed on the checklist's own screen (the settings update no longer carries the flag). */}
        <div className="erp-field" data-testid="dian-defaults">
          {settings.checklist && (
            <p>
              <b>{settings.checklist.confirmed ? t("dian_defaults_confirmed_status") : t("dian_defaults_progress", { done: settings.checklist.done, total: settings.checklist.total })}</b>
            </p>
          )}
          {settings.checklist && settings.checklist.newCount > 0 && (
            <div role="alert" className="erp-dian erp-dian--bad">{t("dian_defaults_new", { count: settings.checklist.newCount })}</div>
          )}
          <Link className="erp-link" href="/invoicing/settings/checklist">{t("open_checklist")}</Link>
          <p className="erp-small erp-muted">{t("production_hint")}</p>
        </div>
        {connection.feedback}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn erp-btn--primary" disabled={connection.busy} onClick={saveConnection}>{t("save_connection")}</button>
        </div>
      </Card>

      <Card title={t("numbering_title")} hint={t("numbering_hint")}>
        <table className="erp-lines__table" aria-label={t("numbering_table")}>
          <thead>
            <tr>
              <th scope="col">{t("document_type")}</th>
              <th scope="col">{t("prefix")}</th>
              <th scope="col">{t("resolution_number")}</th>
              <th scope="col">{t("range")}</th>
              <th scope="col">{t("validity")}</th>
              <th scope="col">{t("next_number")}</th>
              <th scope="col">{t("technical_key")}</th>
            </tr>
          </thead>
          <tbody>
            {numbering.length === 0 && (
              <tr>
                <td colSpan={7} className="erp-muted">{t("numbering_empty")}</td>
              </tr>
            )}
            {numbering.map((row) => (
              <tr key={row.id}>
                <td>{typeLabel(row.documentType)}</td>
                <td>{row.prefix || t("no_prefix")}</td>
                <td>{row.resolution?.number ?? t("no_resolution")}</td>
                <td>{row.resolution ? `${row.resolution.from} – ${row.resolution.to}` : ""}</td>
                <td>{row.resolution ? `${row.resolution.validFrom} – ${row.resolution.validTo}` : ""}</td>
                <td>{row.nextNumber}</td>
                <td>{row.resolution?.technicalKeyEnding ? `•••• ${row.resolution.technicalKeyEnding}` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="erp-form2">
          <Field id={`${f}-type`} label={t("document_type")}>
            <select id={`${f}-type`} value={docType} onChange={(e) => setDocType(e.target.value)}>
              {(["invoice", "credit_note", "debit_note"] as const).map((type) => (
                <option key={type} value={type}>{typeLabel(type)}</option>
              ))}
            </select>
          </Field>
          <Field id={`${f}-prefix`} label={t("prefix")} hint={t("prefix_hint")}>
            <input id={`${f}-prefix`} value={prefix} maxLength={4} onChange={(e) => setPrefix(e.target.value)} autoComplete="off" />
          </Field>
          {docType === "invoice" && (
            <>
              <Field id={`${f}-resnum`} label={t("resolution_number")}>
                <input id={`${f}-resnum`} value={resNumber} inputMode="numeric" onChange={(e) => setResNumber(e.target.value)} autoComplete="off" />
              </Field>
              <Field id={`${f}-from`} label={t("from")}>
                <input id={`${f}-from`} type="number" min={1} value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field id={`${f}-to`} label={t("to")}>
                <input id={`${f}-to`} type="number" min={1} value={to} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Field id={`${f}-vfrom`} label={t("valid_from")}>
                <input id={`${f}-vfrom`} type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
              </Field>
              <Field id={`${f}-vto`} label={t("valid_to")}>
                <input id={`${f}-vto`} type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
              </Field>
              <Field id={`${f}-key`} label={t("technical_key")} hint={t("technical_key_hint")}>
                <input id={`${f}-key`} type="password" value={technicalKey} onChange={(e) => setTechnicalKey(e.target.value)} autoComplete="off" />
              </Field>
            </>
          )}
          <Field id={`${f}-next`} label={t("next_number_optional")} hint={t("next_number_hint")}>
            <input id={`${f}-next`} type="number" min={1} value={nextNumber} onChange={(e) => setNextNumber(e.target.value)} />
          </Field>
        </div>
        {sequence.feedback}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn erp-btn--primary" disabled={sequence.busy} onClick={saveSequence}>{t("register_numbering")}</button>
        </div>
      </Card>

      <Card title={t("certificate_title")} hint={t("certificate_hint", { nit: companyTaxId ?? "" })}>
        {cert ? (
          <dl className="erp-form2">
            <div className="erp-field"><dt>{t("certificate_subject")}</dt><dd>{cert.subject}</dd></div>
            <div className="erp-field"><dt>{t("certificate_tax_id")}</dt><dd>{cert.taxId}</dd></div>
            <div className="erp-field"><dt>{t("certificate_issuer")}</dt><dd>{cert.issuer}</dd></div>
            <div className="erp-field"><dt>{t("certificate_serial")}</dt><dd>{cert.serial}</dd></div>
            <div className="erp-field"><dt>{t("certificate_valid_to")}</dt><dd>{day(cert.validTo)}</dd></div>
            <div className="erp-field"><dt>{t("certificate_uploaded_at")}</dt><dd>{day(cert.uploadedAt)}</dd></div>
          </dl>
        ) : (
          <p className="erp-small">{t("certificate_none")}</p>
        )}
        {/* Task 19 fix round 1: the metadata above reconciled with the certificate actually stored (invoicing.settings.consult). */}
        {cert && (cert.status === "mismatch" || cert.status === "missing" || cert.status === "unverified") && (
          <div role="alert" className="erp-dian erp-dian--bad" data-testid="certificate-status">
            {cert.status === "mismatch" ? t("certificate_status_mismatch") : cert.status === "missing" ? t("certificate_status_missing") : t("certificate_status_unverified")}
          </div>
        )}
        <div className="erp-form2">
          <Field id={`${f}-p12`} label={t("certificate_file")}>
            <input key={fileKey} id={`${f}-p12`} type="file" accept=".p12,.pfx,application/x-pkcs12" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
          <Field id={`${f}-pass`} label={t("certificate_password")}>
            <input id={`${f}-pass`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        {certificate.feedback}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn erp-btn--primary" disabled={certificate.busy || !file || password === ""} onClick={() => void uploadCertificate()}>{t("certificate_upload")}</button>
        </div>
      </Card>

      <Card title={t("pin_title")} hint={settings.pinSetAt ? t("pin_set_at", { date: day(settings.pinSetAt) }) : t("pin_none")}>
        <div className="erp-form2">
          <Field id={`${f}-pin`} label={t("pin_title")}>
            <input id={`${f}-pin`} type="password" value={pin} onChange={(e) => setPin(e.target.value)} autoComplete="off" />
          </Field>
        </div>
        {pinAction.feedback}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn erp-btn--primary" disabled={pinAction.busy || pin.trim() === ""} onClick={savePin}>{t("pin_save")}</button>
        </div>
      </Card>

      <Card title={t("pending_title")} hint={t("pending_hint", { notConfigured: pending.notConfigured, failed: pending.failed })}>
        {resubmit.feedback}
        <div className="erp-row">
          <span className="erp-grow" />
          <button type="button" className="erp-btn" disabled={resubmit.busy} onClick={() => void resubmit.run({})}>{t("resubmit_all")}</button>
        </div>
      </Card>
    </div>
  );
}
