import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { messages } from "@erp/i18n";
import { InvoicingSettingsForm, type SettingsView } from "./settings-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/invoicing/settings" }));
vi.mock("@/lib/invoicing/actions", () => ({ runInvoicingSettingsAction: vi.fn() }));

// The certificate warning of Parámetros › Facturación electrónica (plan 2B Task 37, R37-6, R37-7): the alert shows for mismatch, missing,
// unverified and unreadable, with its status in `data-status`; `ok` and `unknown` show nothing. No key material reaches the HTML (rule 12): the
// page only ever receives the certificate's metadata and its status.

// Real-looking key material the page must never render: it is put INTO the props (the certificate's container, its PEM armour, the password and
// the PIN, under the names a careless loader could use), so a form that printed any prop would fail the test below.
const KEY_MATERIAL = {
  certificateBase64: "MIIKSENTINELp12ZmFrZWNlcnRpZmljYXRlYmFzZTY0Zm9ydGVzdGluZ29ubHk=",
  pem: "-----BEGIN PRIVATE KEY-----\nSENTINELPEMBODY\n-----END PRIVATE KEY-----",
  password: "Sentinel-Passw0rd-9d41",
  pin: "SENTINELPIN-75315",
};

const settings = (status: string): SettingsView => ({
  invoiceCreation: "manual", dianEnvironment: "habilitacion", dianItemInstance: false, creditDays: 30, checklist: null,
  softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: "900373115", testSetId: null,
  issuerTaxResponsibilities: ["O-13"], issuerTaxScheme: "01", issuerDepartmentCode: "11", issuerMunicipalityCode: "11001",
  certificate: { subject: "CAFE DEL NORTE SAS PRUEBA", taxId: "900373115", issuer: "AC Prueba", serial: "0a19", validTo: "2027-12-31T00:00:00.000Z", uploadedAt: "2026-11-07T10:00:00.000Z", status, ...KEY_MATERIAL },
  pinSetAt: "2026-11-07T10:00:00.000Z",
  ...KEY_MATERIAL,
} as SettingsView);

const render = (locale: "es-419" | "en", status: string) =>
  renderToStaticMarkup(
    createElement(
      NextIntlClientProvider,
      { locale, messages: messages(locale), timeZone: "America/Bogota" } as ComponentProps<typeof NextIntlClientProvider>,
      createElement(InvoicingSettingsForm, { settings: settings(status), numbering: [], pending: { notConfigured: 0, failed: 0 }, companyTaxId: "900373115" }),
    ),
  );

const alertOf = (html: string) => /<div role="alert" class="erp-dian erp-dian--bad" data-testid="certificate-status" data-status="(\w+)">([^<]*)<\/div>/.exec(html);

describe("the certificate warning", () => {
  const cases: [string, RegExp][] = [
    ["mismatch", /no es el que describen estos datos/],
    ["missing", /No hay certificado en el almacén de secretos/],
    ["unverified", /antes de la verificación de huella/],
    ["unreadable", /^No se pudo verificar el certificado guardado \(el almacén de secretos no respondió\): inténtalo de nuevo en unos minutos$/],
  ];
  for (const [status, text] of cases) {
    it(`shows the alert for «${status}» with its data-status`, () => {
      const found = alertOf(render("es-419", status));
      expect(found?.[1]).toBe(status);
      expect(found?.[2]).toMatch(text);
    });
  }

  it("shows nothing for «ok» and «unknown»", () => {
    for (const status of ["ok", "unknown"]) expect(render("es-419", status)).not.toContain('data-testid="certificate-status"');
  });

  it("has an English mirror for «unreadable»", () => {
    expect(alertOf(render("en", "unreadable"))?.[2]).toMatch(/could not be verified/i);
  });

  it("the fixture really holds key material (the check below can fail)", () => {
    expect(JSON.stringify(settings("ok"))).toContain(KEY_MATERIAL.password);
    expect(JSON.stringify(settings("ok"))).toContain("BEGIN PRIVATE KEY");
  });

  it("carries no key material in any case (no armour, no password, no PIN)", () => {
    for (const status of ["ok", "mismatch", "missing", "unverified", "unreadable", "unknown"]) {
      const html = render("es-419", status);
      for (const bad of ["BEGIN", "SENTINEL", "75315", "MIIK", KEY_MATERIAL.certificateBase64, KEY_MATERIAL.password, KEY_MATERIAL.pin]) expect(html, `${status} ${bad}`).not.toContain(bad);
      expect(html).not.toMatch(/value="[^"]*(password|contraseña)/i);
    }
  });
});
