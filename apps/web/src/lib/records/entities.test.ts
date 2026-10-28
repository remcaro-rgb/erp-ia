import { describe, expect, it } from "vitest";
import { datosRows, recordEntity } from "./entities";

describe("record entities", () => {
  it("knows the entities that open as a full page and how to read them", () => {
    expect(recordEntity("core.party")).toMatchObject({ consult: "core.party.consult", titleField: "legal_name" });
    expect(recordEntity("core.product")).toMatchObject({ consult: "core.product.consult", titleField: "description" });
  });

  it("refuses anything else, including inherited object keys", () => {
    for (const id of ["core.uom", "kernel.attachments", "constructor", "__proto__", ""]) expect(recordEntity(id)).toBeNull();
  });

  it("lists the scalar columns of a record for the Datos placeholder, leaving out the extra data and empties", () => {
    const rows = datosRows({
      id: "x",
      legal_name: "Supermercados Éxito",
      seq: 7,
      invoice_ready: false,
      dian_missing: ["a"],
      extra: { k: "v" },
      extra_free: [],
      phone: null,
      created_at: new Date("2026-10-28T10:00:00Z"),
    });
    expect(rows).toEqual([
      ["legal_name", "Supermercados Éxito"],
      ["seq", "7"],
      ["invoice_ready", "false"],
      ["dian_missing", "a"],
      ["created_at", "2026-10-28T10:00:00.000Z"],
    ]);
  });
});
