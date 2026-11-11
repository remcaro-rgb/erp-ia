import { describe, expect, it } from "vitest";
import { DIAN_CHECKLIST, DIAN_CHECKLIST_GROUPS } from "../einvoice/dian-checklist";
import { einvoicePack } from "../einvoice/pack";

// The DIAN verification checklist (plan 2B Task 35, owner item 20; R35-1, R35-2): the values the documents carry that the DIAN may still
// ask to change, one row per verifiable claim, in the pack (fiscal content: rule 5). The company's admin ticks each one against the DIAN
// habilitación before producción; the module reads the list only through the pack's interface.

const KEYS = [
  "credit_note_type_91", "export_customization_10", "no_export_debit_type_code", "no_invoice_control_on_notes", "notes_resolution_row", "lotes_en_xml",
  "software_security_code_doc_number", "no_sts_qrcode", "signature_canonicalization",
  "status_code_map", "getstatus_cufe_track_id", "resend_rejected_same_number_cufe", "async_zipkey_loss_in_doubt", "poll_backoff",
  "free_sample_tax_total", "per_unit_other_taxes", "tax_exclusive_amount_excluded_zz", "moneda_extranjera",
  "payment_means_subset", "foreign_buyer_ids_digits", "export_detection_country",
  "issuer_fiscal_profile_builder_only",
  "durable_runner_status_worlds",
  "uvt_2023_2024_values", "other_tax_tariff_tables",
];
const GROUPS = ["notes_documents", "signing_software", "dian_response", "taxes_amounts", "payment_buyers", "issuer_profile", "infrastructure", "reference_tables"];

describe("DIAN_CHECKLIST", () => {
  it("has the 23 items of owner item 20, Task 34.4's moneda_extranjera and Task 28.4's lotes_en_xml, in this order, with unique snake_case keys", () => {
    expect(DIAN_CHECKLIST.items).toHaveLength(25);
    expect(DIAN_CHECKLIST.items.map((i) => i.key)).toEqual(KEYS);
    expect(new Set(DIAN_CHECKLIST.items.map((i) => i.key)).size).toBe(25);
    for (const item of DIAN_CHECKLIST.items) expect(item.key).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("is in the eight groups, in order, every item in one of them", () => {
    expect(DIAN_CHECKLIST_GROUPS).toEqual(GROUPS);
    const seen = [...new Set(DIAN_CHECKLIST.items.map((i) => i.group))];
    expect(seen).toEqual(GROUPS);
    // The items of a group are contiguous (the order is the display order).
    const groups = DIAN_CHECKLIST.items.map((i) => i.group);
    expect(groups).toEqual([...groups].sort((a, b) => GROUPS.indexOf(a) - GROUPS.indexOf(b)));
    expect(GROUPS.map((g) => DIAN_CHECKLIST.items.filter((i) => i.group === g).length)).toEqual([6, 3, 5, 4, 3, 1, 1, 2]);
  });

  it("has Spanish and English text for every item", () => {
    for (const item of DIAN_CHECKLIST.items) {
      expect(item.es.trim().length, item.key).toBeGreaterThan(10);
      expect(item.en.trim().length, item.key).toBeGreaterThan(10);
      expect(item.es, item.key).not.toBe(item.en);
    }
  });

  it("carries its version: the highest since, every since at least 1; a link, when present, is https", () => {
    expect(DIAN_CHECKLIST.version).toBe(Math.max(...DIAN_CHECKLIST.items.map((i) => i.since)));
    expect(DIAN_CHECKLIST.version).toBeGreaterThanOrEqual(1);
    for (const item of DIAN_CHECKLIST.items) {
      expect(item.since, item.key).toBeGreaterThanOrEqual(1);
      expect(Number.isInteger(item.since), item.key).toBe(true);
      if (item.docUrl !== undefined) expect(item.docUrl, item.key).toMatch(/^https:\/\//);
    }
  });

  // Task 34.4 (FX §3): the foreign-currency export invoice was built from the annex, never sent to habilitación: a new row (since 2) clears every
  // confirmation of version 1, so the production guard waits until the admin verified it.
  it("moneda_extranjera is new in version 2 and names what habilitación must accept: the USD document, its totals and the CUFE, the rate's decimals", () => {
    expect(DIAN_CHECKLIST.version).toBe(2);
    const item = DIAN_CHECKLIST.items.find((i) => i.key === "moneda_extranjera")!;
    expect(item).toMatchObject({ group: "taxes_amounts", since: 2 });
    expect(item.es).toMatch(/DocumentCurrencyCode/);
    expect(item.es).toMatch(/PaymentExchangeRate/);
    expect(item.es).toMatch(/CUFE/);
    expect(item.es).toMatch(/CalculationRate/);
    for (const other of DIAN_CHECKLIST.items.filter((i) => i.key !== "moneda_extranjera" && !i.when)) expect(other.since, other.key).toBe(1);
  });

  it("names the claims verbatim from the item: the codes and extensions it asks the admin to check", () => {
    const text = (key: string) => DIAN_CHECKLIST.items.find((i) => i.key === key)!.es;
    expect(text("credit_note_type_91")).toContain("91");
    expect(text("export_customization_10")).toMatch(/CustomizationID.* 10/);
    expect(text("no_invoice_control_on_notes")).toContain("InvoiceControl");
    expect(text("status_code_map")).toContain("00 / 66 / 90 / 98 / 99");
    expect(text("payment_means_subset")).toContain("1, 10, 20, 42, 47, 48, 49, 71, ZZZ");
    expect(text("poll_backoff")).toContain("20");
  });

  it("is what the pack's e-invoice entry offers the modules (rule 5)", () => {
    expect(einvoicePack.dianChecklist).toBe(DIAN_CHECKLIST);
  });

  // Task 28.4 (RG-5, owner item 150): the lots in the XML are verified only by a company that turns them on (invoicing.settings.dian_item_instance):
  // the row applies only then, so it raises no version (a company that never turns it on keeps its confirmation).
  it("lotes_en_xml applies only with the dian_item_instance setting and raises no version", () => {
    const row = DIAN_CHECKLIST.items.find((i) => i.key === "lotes_en_xml")!;
    expect(row).toMatchObject({ group: "notes_documents", when: "dian_item_instance", since: 2 });
    expect(row.es).toMatch(/ItemInstance/);
    expect(DIAN_CHECKLIST.items.filter((i) => i.when)).toEqual([row]);
  });
});
