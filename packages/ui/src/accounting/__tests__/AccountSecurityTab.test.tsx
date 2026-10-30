// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { AccountSecurityTab } from "../AccountSecurityTab";
import type { SaveResult } from "../../forms/save-model";
import type { SecurityDraft, Subject } from "../account-security-model";

beforeAll(stubLayoutApis);
afterEach(cleanup);

const stored: SecurityDraft = {
  access: "restricted",
  grants: [
    { subjectKind: "role", subjectId: "r-contador", subjectName: "contador", canView: true, canPost: true },
    { subjectKind: "role", subjectId: "r-gerencia", subjectName: "gerencia", canView: true, canPost: false },
  ],
};
const subjects: Subject[] = [
  { kind: "role", id: "r-contador", name: "contador" },
  { kind: "role", id: "r-gerencia", name: "gerencia" },
  { kind: "role", id: "r-tesoreria", name: "tesorería" },
  { kind: "user", id: "u-marcela", name: "Marcela Rojas" },
];

describe("AccountSecurityTab", () => {
  it("Quitar saves at once and asks for the code; the code unlocks the same save with the token", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (_input: Record<string, unknown>, token?: string): Promise<SaveResult> => (token ? { ok: true, id: "a-1" } : { ok: false, code: "step_up_required", details: [] }));
    const requestStepUp = vi.fn(async () => ({ token: "tok" }));
    const onSaved = vi.fn();
    renderEs(<AccountSecurityTab accountId="a-1" stored={stored} effective="restricted" inheritedFrom={null} subjects={subjects} save={save} requestStepUp={requestStepUp} onSaved={onSaved} />);

    await user.click(screen.getByRole("button", { name: "Quitar a gerencia" }));
    expect(save).toHaveBeenCalledWith({ accountId: "a-1", access: "restricted", grants: [{ subjectKind: "role", subjectId: "r-contador", canView: true, canPost: true }] }, undefined);
    const code = await screen.findByLabelText("Código de 6 dígitos");
    await user.type(code, "123456");
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(requestStepUp).toHaveBeenCalledWith("123456");
    expect(save.mock.calls[1]![1]).toBe("tok");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("Agregar offers the roles and users not yet granted, starting with ver; contabilizar implies ver", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (): Promise<SaveResult> => ({ ok: true, id: "a-1" }));
    renderEs(<AccountSecurityTab accountId="a-1" stored={stored} effective="restricted" inheritedFrom={null} subjects={subjects} save={save} />);

    const pick = screen.getByRole("combobox", { name: "Rol o usuario por agregar" });
    expect(screen.queryByRole("option", { name: "contador" })).toBeNull();
    await user.selectOptions(pick, "Marcela Rojas");
    await user.click(screen.getByRole("button", { name: "Agregar" }));
    expect((screen.getByRole("checkbox", { name: "Ver · Marcela Rojas" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Contabilizar · Marcela Rojas" }) as HTMLInputElement).checked).toBe(false);

    await user.click(screen.getByRole("checkbox", { name: "Contabilizar · gerencia" }));
    expect((screen.getByRole("checkbox", { name: "Ver · gerencia" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(save).toHaveBeenCalledWith(
      { accountId: "a-1", access: "restricted", grants: [
        { subjectKind: "role", subjectId: "r-contador", canView: true, canPost: true },
        { subjectKind: "role", subjectId: "r-gerencia", canView: true, canPost: true },
        { subjectKind: "user", subjectId: "u-marcela", canView: true, canPost: false },
      ] },
      undefined,
    );
  });

  it("an open account shows no grants grid and says which parent restricts it", () => {
    renderEs(<AccountSecurityTab accountId="a-1" stored={{ access: "open", grants: [] }} effective="restricted" inheritedFrom="5105 · Gastos de personal" subjects={subjects} save={vi.fn()} />);
    expect((screen.getByRole("radio", { name: "Abierta" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Hereda la restricción de 5105 · Gastos de personal")).toBeTruthy();
  });
});
