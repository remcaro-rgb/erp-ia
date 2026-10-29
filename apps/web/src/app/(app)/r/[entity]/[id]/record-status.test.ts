import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import { messages, type Locale } from "@erp/i18n";
import { RecordStatus } from "./record-status";

// The record frame's footer (rule 21): whether the record can go on an invoice, and its DIAN status in words from
// the catalogue, never the stored code ("complete", "missing: 4").

const render = (record: Record<string, unknown>, locale: Locale = "es-419") => {
  const t = createTranslator({ locale, messages: messages(locale) });
  return renderToStaticMarkup(createElement(RecordStatus, { record, t: t as never }));
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("RecordStatus", () => {
  it("shows a complete DIAN status as words in a muted pill", () => {
    const html = render({ invoice_ready: true, dian_status: "complete" });
    expect(text(html)).toBe("✓ Se puede usar en facturas DIAN: completo");
    expect(html).toContain('<span class="erp-pill erp-pill--gray">DIAN: completo</span>');
    expect(html).not.toContain(">complete<");
  });

  it("counts what is missing", () => {
    expect(text(render({ invoice_ready: false, dian_status: "missing: 4" }))).toContain("DIAN: faltan 4 datos");
    expect(text(render({ invoice_ready: false, dian_status: "missing: 1" }))).toContain("DIAN: falta 1 dato");
    expect(text(render({ dian_status: "missing: 4" }, "en"))).toBe("DIAN: 4 items missing");
  });

  it("reads anything else as errors, and shows nothing for a record without either", () => {
    expect(text(render({ dian_status: "errors" }))).toBe("DIAN: con errores");
    expect(render({})).toBe("");
  });
});
