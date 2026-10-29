import { describe, expect, it } from "vitest";
import type { AuditEntryDetail, ValueLabels } from "@erp/kernel";
import { actorHref, auditRecordHref, presentAuditDetail, SYSTEM_ACTOR } from "./audit-view";

// The audit viewer's detail of one entry (design §22.14, rule 16): every changed field as `label · antes → después`,
// values as the forms show them (option and code labels, money, dates in the company's zone), `••••••` for a field the
// viewer sees masked, and the links of the record, its source and the actor (rule 21).

const CATALOGUE: Record<string, string> = {
  "common.yes": "Sí",
  "common.no": "No",
  "field.core.party.trade_name": "Nombre comercial",
  "field.core.party.credit_limit": "Cupo de crédito",
  "field.core.party.kind": "Tipo de tercero",
  "field.core.party.document_type": "Tipo de documento",
  "field.core.party.legal_name": "Razón social",
  "grid.values.party_kind.customer": "Cliente",
  "common.admin.audit.detail.code": "Motivo",
  "errors.forbidden": "No tienes permiso para hacer esto.",
  "field.kernel.audit.process_id": "Proceso",
};
const labels: ValueLabels = {
  t: (key) => CATALOGUE[key],
  locale: "es-419",
  pack: { codeLabel: (_table, code) => (code === "31" ? "31 · NIT" : undefined) },
  timeZone: "America/Bogota",
};

const entry = (over: Partial<AuditEntryDetail["entry"]> = {}): AuditEntryDetail["entry"] => ({
  id: "0192f000-0000-7000-8000-000000000001",
  occurredAt: "2026-10-29T15:30:00.000Z",
  origin: "ui",
  processId: "core.party.update",
  processDescription: "Actualiza los datos de un tercero y recalcula su estado DIAN",
  entity: "core.party",
  entityId: "core.party",
  entityLabel: "entity.core.party",
  rowId: "0192f000-0000-7000-8000-0000000000aa",
  rowTitle: "Almacenes Éxito S.A.",
  action: "update",
  actorUserId: "0192f000-0000-7000-8000-0000000000bb",
  actor: "laura@demo.local",
  chainId: "0192f000-0000-7000-8000-0000000000cc",
  sourceRowId: null,
  sourceTitle: null,
  ...over,
});

describe("presentAuditDetail", () => {
  it("reads each change as label · before → after, with a dash for nothing and money as $ 1.234.567,00", () => {
    const view = presentAuditDetail(
      {
        entry: entry(),
        changes: [
          { field: "trade_name", labelKey: "field.core.party.trade_name", type: "text", masked: false, before: null, after: "Bosque QA" },
          { field: "credit_limit", labelKey: "field.core.party.credit_limit", type: "money", masked: false, before: 0, after: "1500000.0000" },
          { field: "kind", labelKey: "field.core.party.kind", type: "json", valuesKey: "grid.values.party_kind", masked: false, before: [], after: ["customer"] },
          { field: "extra.canal", labelKey: null, labelText: "Canal de venta", type: "text", masked: false, before: "Norte", after: null },
          { field: "status_code", labelKey: null, type: null, masked: false, before: "a", after: "b" },
        ],
        input: null,
        described: true,
      },
      labels,
    );
    expect(view.changes.map((c) => `${c.label} · ${c.before} → ${c.after}`)).toEqual([
      "Nombre comercial · — → Bosque QA",
      "Cupo de crédito · $ 0,00 → $ 1.500.000,00",
      "Tipo de tercero · — → Cliente",
      "Canal de venta · Norte → —",
      "status_code · a → b",
    ]);
    expect(view.input).toBeNull();
    expect(view.rowHref).toBe("/r/core.party/0192f000-0000-7000-8000-0000000000aa");
  });

  it("shows •••••• in before and after for a masked field, and nothing of its values", () => {
    const view = presentAuditDetail(
      { entry: entry(), changes: [{ field: "credit_limit", labelKey: "field.core.party.credit_limit", type: "money", masked: true, before: null, after: null }], input: null, described: true },
      labels,
    );
    expect(view.changes).toEqual([{ field: "credit_limit", label: "Cupo de crédito", before: "••••••", after: "••••••", masked: true }]);
  });

  it("shows a creation's input with labels and codes, and the record it was cloned from as a link", () => {
    const view = presentAuditDetail(
      {
        entry: entry({ action: "insert", processId: "core.party.create", sourceRowId: "0192f000-0000-7000-8000-0000000000dd", sourceTitle: "Almacenes Éxito S.A." }),
        changes: [],
        input: [
          { key: "documentType", field: "document_type", labelKey: "field.core.party.document_type", type: "text", codes: "documentTypes", masked: false, value: "31" },
          { key: "legalName", field: "legal_name", labelKey: "field.core.party.legal_name", type: "text", masked: false, value: "Bosque QA S.A.S." },
          { key: "creditLimit", field: "credit_limit", labelKey: "field.core.party.credit_limit", type: "money", masked: true, value: null },
        ],
        described: true,
      },
      labels,
    );
    expect(view.input).toEqual([
      { key: "documentType", label: "Tipo de documento", value: "31 · NIT", masked: false },
      { key: "legalName", label: "Razón social", value: "Bosque QA S.A.S.", masked: false },
      { key: "creditLimit", label: "Cupo de crédito", value: "••••••", masked: true },
    ]);
    expect(view.source).toEqual({ id: "0192f000-0000-7000-8000-0000000000dd", title: "Almacenes Éxito S.A.", href: "/r/core.party/0192f000-0000-7000-8000-0000000000dd" });
  });

  it("names a refusal's reason and process in words", () => {
    const view = presentAuditDetail(
      {
        entry: entry({ action: "denied" }),
        changes: [],
        input: [
          { key: "code", field: null, labelKey: null, type: null, masked: false, value: "forbidden" },
          { key: "process_id", field: null, labelKey: null, type: null, masked: false, value: "core.party.update" },
        ],
        described: true,
      },
      labels,
    );
    expect(view.input).toEqual([
      { key: "code", label: "Motivo", value: "No tienes permiso para hacer esto.", masked: false },
      { key: "process_id", label: "Proceso", value: "core.party.update", masked: false },
    ]);
  });
});

describe("presentAuditDetail on a platform table", () => {
  it("says the entry has no field detail instead of listing values", () => {
    const view = presentAuditDetail({ entry: entry({ entity: "kernel.agent_confirmations", entityId: null, entityLabel: null }), changes: [], input: null, described: false }, labels);
    expect(view.described).toBe(false);
    expect(view.changes).toEqual([]);
    expect(view.rowHref).toBeNull();
  });
});

describe("links", () => {
  it("opens a record of an entity with a page, and the actor's user page except for the system", () => {
    expect(auditRecordHref("core.party", "p1")).toBe("/r/core.party/p1");
    expect(auditRecordHref("core.product_category", "c1")).toBe("/r/core.product_category/c1");
    expect(auditRecordHref("support.ticket", "t1")).toBe("/r/support.ticket/t1");
    expect(auditRecordHref("kernel.audit", "a1")).toBeNull();
    expect(auditRecordHref("kernel.user", "u1")).toBe("/admin/users/u1");
    expect(auditRecordHref(null, "a1")).toBeNull();
    expect(auditRecordHref("core.party", null)).toBeNull();
    expect(actorHref("u1")).toBe("/admin/users/u1");
    expect(actorHref(SYSTEM_ACTOR)).toBeNull();
    expect(actorHref(null)).toBeNull();
  });
});
