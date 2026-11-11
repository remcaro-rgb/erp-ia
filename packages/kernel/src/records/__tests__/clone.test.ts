import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineProcess } from "../../process/define";
import { defineEntity, Registry, type EntityDef } from "../../registry";
import { cloneDraft, draftValues } from "../clone";

// Cloning a record (rule 37, design §22.13): the clone's create input is the source's visible data without the
// server-managed columns, the secret ones and the entity's own `cloneReset` fields.

const party: EntityDef = {
  entityType: "maestro",
  id: "test.party",
  module: "test",
  schema: "test",
  table: "parties",
  label: "entity.test.party",
  displayField: "legal_name",
  defaultSort: { field: "legal_name", dir: "asc" },
  fields: [
    { name: "seq", type: "number", label: "f.seq", required: true },
    { name: "kind", type: "json", label: "f.kind" },
    { name: "document_number", type: "text", label: "f.document_number", required: true },
    { name: "check_digit", type: "text", label: "f.check_digit" },
    { name: "legal_name", type: "text", label: "f.legal_name", required: true },
    { name: "trade_name", type: "text", label: "f.trade_name" },
    { name: "credit_limit", type: "money", label: "f.credit_limit", sensitivity: "confidential" },
    { name: "min_stock", type: "number", label: "f.min_stock" },
    { name: "is_active", type: "boolean", label: "f.is_active" },
    { name: "token", type: "text", label: "f.token" },
    { name: "dian_status", type: "text", label: "f.dian_status" },
    { name: "invoice_ready", type: "boolean", label: "f.invoice_ready" },
    { name: "extra", type: "json", label: "f.extra" },
    { name: "extra_free", type: "json", label: "f.extra_free" },
    { name: "created_at", type: "datetime", label: "f.created_at" },
    { name: "updated_at", type: "datetime", label: "f.updated_at" },
  ],
  cloneReset: ["document_number", "check_digit", "seq", "dian_status", "invoice_ready"],
};

const createInput = z.object({
  kind: z.array(z.string()).min(1),
  documentNumber: z.string().min(1),
  legalName: z.string(),
  tradeName: z.string().optional(),
  creditLimit: z.number().min(0).optional(),
  minStock: z.number().optional(),
  isActive: z.boolean().default(true),
  token: z.string().optional(),
  // A create input key that is not a field of the entity is never filled from the record.
  note: z.string().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  extraFree: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});

function registryWith(entity: EntityDef, withCreate = true): Registry {
  const registry = new Registry();
  registry.registerEntity(defineEntity(entity));
  if (withCreate) {
    registry.registerProcess(
      defineProcess({ id: `${entity.id}.create`, module: "test", kind: "create", description: "prueba", input: createInput, output: z.object({ id: z.string() }), handler: async () => ({ id: "x" }) }),
    );
  }
  return registry;
}

const SOURCE = {
  id: "0192a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  company_id: "0192a1b2-c3d4-7e5f-8a9b-000000000001",
  seq: 7,
  kind: ["customer"],
  document_number: "890900608",
  check_digit: "9",
  legal_name: "Almacenes Éxito S.A.",
  trade_name: null,
  credit_limit: "250000000.0000",
  min_stock: "12",
  is_active: true,
  token: "s3cr3t",
  dian_status: "complete",
  invoice_ready: true,
  note: "not a field",
  extra: { canal: "Mayoristas" },
  extra_free: [{ name: "Ruta", value: "Norte 3" }],
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  created_by: "0192a1b2-c3d4-7e5f-8a9b-000000000002",
};

describe("cloneDraft", () => {
  it("is the create input of the visible record without cloneReset, server-managed and secret fields", () => {
    const draft = cloneDraft(registryWith(party), "test.party", SOURCE);
    expect(draft).toEqual({
      kind: ["customer"],
      legalName: "Almacenes Éxito S.A.",
      creditLimit: 250000000,
      minStock: 12,
      isActive: true,
      extra: { canal: "Mayoristas" },
      extraFree: [{ name: "Ruta", value: "Norte 3" }],
    });
    for (const key of ["id", "companyId", "seq", "documentNumber", "checkDigit", "token", "dianStatus", "invoiceReady", "note", "createdAt", "createdBy"]) {
      expect(draft).not.toHaveProperty(key);
    }
  });

  it("never copies a field the viewer does not see: masked values come back null, and a non-visible mode drops it", () => {
    const masked = cloneDraft(registryWith(party), "test.party", { ...SOURCE, credit_limit: null });
    expect(masked).not.toHaveProperty("creditLimit");
    const byMode = cloneDraft(registryWith(party), "test.party", SOURCE, { credit_limit: "masked", trade_name: "hidden", extra: "masked" });
    expect(byMode).not.toHaveProperty("creditLimit");
    expect(byMode).not.toHaveProperty("extra");
    expect(byMode.legalName).toBe("Almacenes Éxito S.A.");
  });

  it("leaves out empty extra data", () => {
    const draft = cloneDraft(registryWith(party), "test.party", { ...SOURCE, extra: {}, extra_free: [] });
    expect(draft).not.toHaveProperty("extra");
    expect(draft).not.toHaveProperty("extraFree");
  });

  it("does not mutate the source record and the draft's lists are copies", () => {
    const source = structuredClone(SOURCE);
    const draft = cloneDraft(registryWith(party), "test.party", source);
    (draft.kind as string[]).push("supplier");
    expect(source).toEqual(SOURCE);
  });

  it("copies a calendar date the driver hands as a Date (yyyy-mm-dd, as the create input takes it) and a datetime as ISO (Task 28.5)", () => {
    const lot: EntityDef = {
      ...party,
      id: "test.lot",
      table: "lots",
      fields: [...party.fields, { name: "expires_on", type: "date", label: "f.expires_on" }, { name: "seen_at", type: "datetime", label: "f.seen_at" }],
    };
    const registry = new Registry();
    registry.registerEntity(defineEntity(lot));
    const input = createInput.extend({ expiresOn: z.iso.date().optional(), seenAt: z.iso.datetime().optional() });
    registry.registerProcess(defineProcess({ id: "test.lot.create", module: "test", kind: "create", description: "prueba", input, output: z.object({ id: z.string() }), handler: async () => ({ id: "x" }) }));
    const draft = cloneDraft(registry, "test.lot", { ...SOURCE, expires_on: new Date("2027-05-29T00:00:00Z"), seen_at: new Date("2026-11-10T15:30:00Z") });
    expect(draft).toMatchObject({ expiresOn: "2027-05-29", seenAt: "2026-11-10T15:30:00.000Z" });
  });

  it("refuses an entity without a create process", () => {
    expect(() => cloneDraft(registryWith(party, false), "test.party", SOURCE)).toThrow();
    expect(() => cloneDraft(registryWith(party), "test.nope", SOURCE)).toThrow();
  });

  it("draftValues gives the draft back by field name, the shape a create form starts from", () => {
    const registry = registryWith(party);
    const values = draftValues(registry, "test.party", cloneDraft(registry, "test.party", SOURCE));
    expect(values).toEqual({
      kind: ["customer"],
      legal_name: "Almacenes Éxito S.A.",
      credit_limit: 250000000,
      min_stock: 12,
      is_active: true,
      extra: { canal: "Mayoristas" },
      extra_free: [{ name: "Ruta", value: "Norte 3" }],
    });
  });
});

describe("defineEntity cloneReset", () => {
  it("accepts declared fields and refuses an unknown one", () => {
    expect(defineEntity(party).cloneReset).toEqual(["document_number", "check_digit", "seq", "dian_status", "invoice_ready"]);
    expect(() => defineEntity({ ...party, cloneReset: ["nope"] })).toThrow(/cloneReset nope/);
  });
});
