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
    const flag = screen.getByLabelText(/Exige tercero listo para facturar/);
    const described = flag.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described!)?.textContent).toMatch(/Solo acepta terceros listos para facturar/);
  });
});
