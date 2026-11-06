import { defineProcess, installedEInvoiceTransport, secretStore, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { DIAN_ENVIRONMENTS, INVOICE_CREATION } from "../entities";
import { softwarePinSecret } from "../einvoice-secrets";
import { FEATURE_SETTINGS, id, packOf, refuseState, requireCompanyAdmin, settingsOf } from "./common";
import { ADMIN_ONLY, certificateStatus, PARAMETROS_PROCESSES } from "./parametros";

// Parámetros de facturación (plan 2B Task 16; the page is Task 19): how invoices are created (OD-2: manual, on_delivery,
// on_order_confirmation; default manual), the DIAN environment the CUFE names, the default cost center of the revenue line and the days of
// credit of a sale on credit. STEP-UP: switching to an automatic mode makes invoices that post by themselves.
// Producción (Task 19; Tasks 17/18 carry-overs) is reached only when everything the real DIAN needs is in place, checked here:
//   1. the DIAN defaults confirmed (dian_defaults_confirmed, false by default and set only here): CreditNoteTypeCode 91 on every credit note,
//      CustomizationID 10 on export invoices and no InvoiceControl on notes are what the documents carry until the DIAN asks otherwise;
//   2. the configured transport serves producción (EINVOICE_TRANSPORT=dian-produccion, or an installed override that says so): the mock, the
//      default of CI and Docker, and habilitación never send a producción document (the workflow checks it again on every sending);
//   3. the software registered with the DIAN, the signing certificate and the software PIN (both in the secret store).
// Back to habilitación is always allowed; while in producción the confirmation cannot be withdrawn (the database holds it too: 0101).

/** The DIAN defaults the company confirms before producción (Task 18: what the DIAN may still ask to change). */
const DIAN_DEFAULTS = [
  "Las notas crédito se envían con el tipo 91 (CreditNoteTypeCode)",
  "Las facturas de exportación se envían con CustomizationID 10",
  "Las notas crédito y débito se envían sin InvoiceControl (sin resolución de numeración)",
];

/** Producción only with the defaults confirmed, a transport that serves it, the software, the certificate and the PIN. */
async function assertProductionReady(ctx: ProcessContext, confirmed: boolean, softwareId: string | null): Promise<void> {
  if (!confirmed) {
    refuseState("dian_defaults_unconfirmed", [
      "Confirma los valores por defecto del documento electrónico antes de pasar a producción: " + DIAN_DEFAULTS.join("; "),
      ...DIAN_DEFAULTS,
    ]);
  }
  const { einvoice } = await packOf(ctx);
  const secrets = secretStore();
  try {
    const installed = installedEInvoiceTransport();
    if (installed) einvoice.assertTransportEnvironment(installed, "produccion");
    else einvoice.transport({ companyId: ctx.companyId, environment: "produccion", ...(secrets ? { secrets } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("einvoice_environment_mismatch")) {
      refuseState("einvoice_environment_mismatch", ["El servidor no está configurado para enviar a la DIAN en producción (EINVOICE_TRANSPORT=dian-produccion): la empresa sigue en habilitación"]);
    }
    refuseState("einvoice_transport_not_configured", [`El envío a la DIAN en producción no está configurado en el servidor: ${message}`]);
  }
  if (!softwareId) refuseState("einvoice_not_configured", ["Registra el software de facturación electrónica (su identificador ante la DIAN) antes de pasar a producción"]);
  if (!secrets) refuseState("secret_store_not_configured", ["El servidor no tiene configurado el almacén de secretos (Supabase Vault)"]);
  const [certificate, pin] = await Promise.all([secrets.get(`dian/${ctx.companyId}/certificate`), secrets.get(softwarePinSecret(ctx.companyId))]);
  if (!certificate) refuseState("certificate_missing", ["Sube el certificado de firma digital (.p12) de la empresa antes de pasar a producción"]);
  if (!pin) refuseState("software_pin_missing", ["Guarda el PIN del software de facturación electrónica antes de pasar a producción"]);
  // Task 19 fix round 2: a current certificate, and the one the Parámetros describe (not a half-finished upload).
  const [meta] = await ctx.tx<{ valid_to: Date | null; fingerprint: string | null }[]>`
    select certificate_valid_to as valid_to, certificate_fingerprint as fingerprint from invoicing.settings where company_id = ${ctx.companyId}`;
  if (!meta?.valid_to || new Date(meta.valid_to).getTime() < Date.now()) {
    refuseState("certificate_expired", ["El certificado de firma digital está vencido: sube el certificado vigente antes de pasar a producción"]);
  }
  if ((await certificateStatus(ctx, meta.fingerprint)) !== "ok") {
    refuseState("certificate_mismatch", ["El certificado guardado no es el que describen los Parámetros: súbelo de nuevo antes de pasar a producción"]);
  }
}

export const settingsUpdate = defineProcess({
  id: "invoicing.settings.update",
  module: "invoicing",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_SETTINGS,
  sensitivity: "step-up",
  description:
    "Cambia los parámetros de facturación: cuándo se crean las facturas (a mano, al despachar cada entrega o al confirmar el pedido), el ambiente DIAN, el centro de costo por defecto, los días de crédito, el software registrado ante la DIAN y el perfil fiscal de la empresa como emisor",
  input: z.object({
    invoiceCreation: z.enum(INVOICE_CREATION).optional(),
    dianEnvironment: z.enum(DIAN_ENVIRONMENTS).optional(),
    defaultCostCenterId: id.nullable().optional(),
    creditDays: z.number().int().min(0).max(365).optional(),
    // The DIAN submission (Task 17; Task 19's page edits them): the software registered with the DIAN, the habilitación test set and the
    // company's fiscal profile as issuer. The software PIN is a secret (rule 12): never an input here.
    softwareId: z.string().trim().min(1).max(100).nullable().optional(),
    softwareProviderTaxId: z.string().regex(/^[0-9]{5,15}$/, "El NIT del proveedor de software va sin dígito de verificación").nullable().optional(),
    testSetId: z.string().trim().min(1).max(100).nullable().optional(),
    issuerTaxResponsibilities: z.array(z.string().trim().min(1).max(10)).max(20).optional(),
    issuerTaxScheme: z.enum(["01", "04", "ZA", "ZZ"]).optional(),
    issuerDepartmentCode: z.string().regex(/^[0-9]{2}$/).nullable().optional(),
    issuerMunicipalityCode: z.string().regex(/^[0-9]{5}$/).nullable().optional(),
    /** The DIAN defaults confirmed (Task 18's list): required for producción. */
    dianDefaultsConfirmed: z.boolean().optional(),
  }).strict(),
  output: z.object({
    id: z.string(),
    invoiceCreation: z.enum(INVOICE_CREATION),
    dianEnvironment: z.enum(DIAN_ENVIRONMENTS),
    defaultCostCenterId: z.string().nullable(),
    creditDays: z.number(),
    softwareId: z.string().nullable(),
    softwareProviderTaxId: z.string().nullable(),
    testSetId: z.string().nullable(),
    issuerTaxResponsibilities: z.array(z.string()),
    issuerTaxScheme: z.string(),
    issuerDepartmentCode: z.string().nullable(),
    issuerMunicipalityCode: z.string().nullable(),
    dianDefaultsConfirmed: z.boolean(),
  }),
  handler: async (ctx, input) => {
    await requireCompanyAdmin(ctx, ADMIN_ONLY);
    const current = await settingsOf(ctx);
    const [stored] = await ctx.tx<Record<string, unknown>[]>`
      select software_id, software_provider_tax_id, test_set_id, issuer_tax_responsibilities, issuer_tax_scheme, issuer_department_code, issuer_municipality_code,
             dian_defaults_confirmed
      from invoicing.settings where company_id = ${ctx.companyId}`;
    const keep = <T>(given: T | undefined, column: string, fallback: unknown = null) => (given === undefined ? (stored?.[column] ?? fallback) : given);
    const submission = {
      software_id: keep(input.softwareId, "software_id"),
      software_provider_tax_id: keep(input.softwareProviderTaxId, "software_provider_tax_id"),
      test_set_id: keep(input.testSetId, "test_set_id"),
      issuer_tax_responsibilities: keep(input.issuerTaxResponsibilities, "issuer_tax_responsibilities", []),
      issuer_tax_scheme: keep(input.issuerTaxScheme, "issuer_tax_scheme", "01"),
      issuer_department_code: keep(input.issuerDepartmentCode, "issuer_department_code"),
      issuer_municipality_code: keep(input.issuerMunicipalityCode, "issuer_municipality_code"),
    };
    const next = {
      invoice_creation: input.invoiceCreation ?? current.invoiceCreation,
      dian_environment: input.dianEnvironment ?? current.dianEnvironment,
      default_cost_center_id: input.defaultCostCenterId === undefined ? current.defaultCostCenterId : input.defaultCostCenterId,
      credit_days: input.creditDays ?? current.creditDays,
      dian_defaults_confirmed: input.dianDefaultsConfirmed ?? ((stored?.dian_defaults_confirmed as boolean | undefined) ?? false),
    };
    if (next.dian_environment === "produccion") await assertProductionReady(ctx, next.dian_defaults_confirmed, submission.software_id as string | null);
    // An upsert's CHECK runs on the row it proposes to insert (no certificate there), so the row is made first and then updated: the
    // database's producción guard (0105) judges the row as it ends up.
    await ctx.tx`insert into invoicing.settings ${ctx.tx({ company_id: ctx.companyId } as never)} on conflict (company_id) do nothing`;
    const [row] = await ctx.tx<{ id: string }[]>`
      update invoicing.settings set ${ctx.tx({ ...next, ...submission } as never)} where company_id = ${ctx.companyId}
      returning id`;
    return {
      id: row!.id, invoiceCreation: next.invoice_creation, dianEnvironment: next.dian_environment, defaultCostCenterId: next.default_cost_center_id, creditDays: next.credit_days,
      softwareId: submission.software_id as string | null, softwareProviderTaxId: submission.software_provider_tax_id as string | null,
      testSetId: submission.test_set_id as string | null, issuerTaxResponsibilities: submission.issuer_tax_responsibilities as string[],
      issuerTaxScheme: submission.issuer_tax_scheme as string, issuerDepartmentCode: submission.issuer_department_code as string | null,
      issuerMunicipalityCode: submission.issuer_municipality_code as string | null,
      dianDefaultsConfirmed: next.dian_defaults_confirmed,
    };
  },
});

export const settingsConsult = defineProcess({
  id: "invoicing.settings.consult",
  module: "invoicing",
  kind: "consult",
  feature: FEATURE_SETTINGS,
  description: "Consulta los parámetros de facturación de la empresa (a mano, habilitación y 30 días de crédito mientras no se hayan configurado)",
  input: z.object({}),
  output: z.looseObject({ configured: z.boolean() }),
  handler: async (ctx) => {
    const [row] = await ctx.tx`select * from invoicing.v_settings where company_id = ${ctx.companyId}`;
    const defaults = await settingsOf(ctx);
    // Task 19 fix round 1: the metadata reconciled with the certificate actually stored (see processes/parametros.ts).
    if (row) return { ...row, configured: true, certificate_status: await certificateStatus(ctx, (row.certificate_fingerprint as string | null) ?? null) };
    return { configured: false, invoice_creation: defaults.invoiceCreation, dian_environment: defaults.dianEnvironment, default_cost_center_id: null, credit_days: defaults.creditDays };
  },
});

export const SETTINGS_PROCESSES = [settingsUpdate, settingsConsult, ...PARAMETROS_PROCESSES];
