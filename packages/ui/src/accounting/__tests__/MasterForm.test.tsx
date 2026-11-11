// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { MasterForm } from "../MasterForm";

beforeAll(stubLayoutApis);
afterEach(cleanup);

describe("MasterForm", () => {
  it("the account form shows the invoice-ready flag with its hint, next to Exige tercero", () => {
    renderEs(<MasterForm kind="account" processes={{ create: "accounting.account.create", update: "accounting.account.update" }} record={null} save={async () => ({ ok: true, id: "a-1" })} />);
    const flag = screen.getByRole("switch", { name: /Exige tercero listo para facturar/ });
    const described = flag.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toMatch(/Solo acepta terceros listos para facturar/);
  });
});

describe("MasterForm of a stored account", () => {
  const record = { id: "a-1", code: "111005", name: "Moneda nacional", nature: "debit", statement_section: "assets_current", requires_party: false, is_active: true, level: "subaccount", allows_movement: false, updated_at: "2026-11-03" };
  const show = () => renderEs(<MasterForm kind="account" processes={{ create: "accounting.account.create", update: "accounting.account.update" }} record={record} save={async () => ({ ok: true, id: "a-1" })} />);

  it("shows the yes/no fields as on/off chips, the movement fact included", () => {
    show();
    expect(screen.getByRole("switch", { name: /^Exige tercero (Sí|No)/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: /Activa/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: /Admite movimientos/ }).getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("names the statement section, never its code", () => {
    show();
    expect(screen.getByDisplayValue("Activo corriente")).toBeTruthy();
    expect(screen.queryByText("assets_current")).toBeNull();
  });

  it("copies the code and has no DIAN switch", () => {
    show();
    expect(screen.getByRole("button", { name: /Copiar/ })).toBeTruthy();
    expect(screen.queryByText(/códigos DIAN/)).toBeNull();
  });
});
