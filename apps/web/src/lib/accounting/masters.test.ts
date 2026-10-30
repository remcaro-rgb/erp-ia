import { describe, expect, it } from "vitest";
import { USER_PREF_KEY } from "@erp/kernel";
import { canHangAuxiliary, createInputFor, masterPage, masterViewKey, MASTER_PAGES, parseMasterView } from "./masters";

describe("accounting masters", () => {
  it("the Tabla · Árbol preference key is a valid user preference key for each of the five masters", () => {
    for (const master of MASTER_PAGES) expect(masterViewKey(master.entity)).toMatch(USER_PREF_KEY);
    expect(masterViewKey("accounting.cost_center")).toBe("master_view.accounting.cost_center");
    expect(MASTER_PAGES).toHaveLength(5);
    expect(masterPage("accounting.journal")).toBeNull();
  });

  it("an unknown or missing preference means Tabla", () => {
    expect(parseMasterView({ value: "tree", savedAt: 1 })).toBe("tree");
    expect(parseMasterView("tree")).toBe("tree");
    expect(parseMasterView(undefined)).toBe("table");
    expect(parseMasterView({ value: "cards" })).toBe("table");
  });

  it("an auxiliary account hangs from a subcuenta or another auxiliary only", () => {
    expect(["class", "group", "account", "subaccount", "auxiliary"].filter(canHangAuxiliary)).toEqual(["subaccount", "auxiliary"]);
  });

  it("builds the create input: accounts take a code and a name, dimension nodes also parent, kind and state", () => {
    expect(createInputFor("accounting.account", { code: " 13050501 ", name: " Clientes Éxito " })).toEqual({ code: "13050501", name: "Clientes Éxito" });
    expect(createInputFor("accounting.item", { code: "A", name: "Café", parentId: "", kind: "leaf" })).toEqual({ code: "A", name: "Café", parentId: null, kind: "leaf", isActive: true });
  });
});
