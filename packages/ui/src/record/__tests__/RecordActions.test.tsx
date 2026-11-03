// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEs, stubLayoutApis } from "../../shell/__tests__/intl";
import { RecordActions } from "../RecordActions";
import { barButtons, type RecordRights } from "../record-actions-model";

beforeAll(stubLayoutApis);
afterEach(cleanup);

const ALL: RecordRights = { modify: true, delete: true, void: true, approve: true };
const NONE: RecordRights = { modify: false, delete: false, void: false, approve: false };
const ok = async () => ({ ok: true as const });
const names = (type: "maestro" | "documento", status: Parameters<typeof barButtons>[1], requiresApproval: boolean, posts: boolean, rights = ALL) =>
  barButtons(type, status, { requiresApproval, posts }, rights).map((b) => b.action);

describe("barButtons (D15, allowedActions ∩ rights)", () => {
  it("documento without approval that posts: Guardar and Eliminar in Borrador; nothing once Contabilizado; never a Contabilizar button", () => {
    expect(names("documento", "draft", false, true)).toEqual(["save", "delete"]);
    expect(names("documento", "posted", false, true)).toEqual([]);
    expect(names("documento", "saved", false, true)).toEqual(["save", "void"]);
  });

  it("documento with approval: Guardar + Guardar y enviar while editable before approval, Enviar alone only in Grabado", () => {
    expect(names("documento", "draft", true, true)).toEqual(["save", "save_submit", "delete"]);
    expect(names("documento", "saved", true, true)).toEqual(["save", "save_submit", "submit", "void"]);
    expect(names("documento", "pending", true, true)).toEqual(["approve", "reject", "void"]);
    expect(names("documento", "rejected", true, true)).toEqual(["save", "save_submit", "void"]);
    expect(names("documento", "approved", true, false)).toEqual(["void"]);
    expect(names("documento", "voided", true, true)).toEqual([]);
  });

  it("maestro: Guardar and Eliminar; with approval Aprobar / No aprobar in Pendiente; an Aprobado maestro only Guardar (D10)", () => {
    expect(names("maestro", "saved", false, false)).toEqual(["save", "delete"]);
    expect(names("maestro", "pending", true, false)).toEqual(["save", "approve", "reject", "delete"]);
    expect(names("maestro", "approved", true, false)).toEqual(["save", "delete"]);
  });

  it("rights narrow the buttons: no approve permission, no Aprobar / No aprobar; no rights, no buttons", () => {
    expect(names("documento", "pending", true, true, { ...ALL, approve: false })).toEqual(["void"]);
    expect(names("documento", "draft", true, true, { ...ALL, delete: false })).toEqual(["save", "save_submit"]);
    expect(names("maestro", "pending", true, false, NONE)).toEqual([]);
  });

  it("Aprobar and No aprobar each follow their own process (review m6)", () => {
    expect(names("documento", "pending", true, true, { ...ALL, reject: false })).toEqual(["approve", "void"]);
    expect(names("documento", "pending", true, true, { ...ALL, approve: false, reject: true })).toEqual(["reject", "void"]);
  });
});

describe("RecordActions", () => {
  it("shows Nuevo, Imprimir, Notificar (documento), Duplicar and the state buttons with Guardar y enviar a aprobación as primary", () => {
    renderEs(<RecordActions entityType="documento" status="saved" flags={{ requiresApproval: true, posts: true }} rights={ALL} dirty={false} tools={{ new: true, print: true, notify: true, duplicate: true }} onAction={ok} />);
    for (const name of ["Nuevo", "Imprimir", "Notificar", "Guardar", "Guardar y enviar a aprobación", "Enviar a aprobación", "Anular"]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Duplicar" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Contabilizar/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Guardar y enviar a aprobación" }).className).toContain("erp-btn--primary");
    expect(screen.getByText(/Se contabiliza automáticamente/)).toBeTruthy();
  });

  it("minor 2: a double click on a state button runs the action once", async () => {
    let finish: () => void = () => {};
    const onAction = vi.fn(() => new Promise<{ ok: true }>((resolve) => (finish = () => resolve({ ok: true }))));
    renderEs(<RecordActions entityType="documento" status="saved" flags={{ requiresApproval: true, posts: true }} rights={ALL} dirty={false} onAction={onAction} />);
    const send = screen.getByRole("button", { name: "Enviar a aprobación" });
    fireEvent.click(send);
    fireEvent.click(send);
    finish();
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
  });

  it("minor 7: a success notice kept across the navigation shows when the bar mounts", () => {
    renderEs(<RecordActions entityType="documento" status="pending" flags={{ requiresApproval: true, posts: true }} rights={ALL} dirty={false} onAction={ok} initialNotice="Listo" />);
    expect(screen.getByRole("status").textContent).toBe("Listo");
  });

  it("a maestro has no Notificar", () => {
    renderEs(<RecordActions entityType="maestro" status="saved" flags={{ requiresApproval: false, posts: false }} rights={ALL} dirty={false} tools={{ new: true, print: true, notify: true }} onAction={ok} />);
    expect(screen.queryByRole("button", { name: "Notificar" })).toBeNull();
  });

  it("unsaved edits disable the state buttons with the reason, and Imprimir and Notificar", () => {
    renderEs(<RecordActions entityType="documento" status="saved" flags={{ requiresApproval: true, posts: true }} rights={ALL} dirty tools={{ print: true, notify: true }} onAction={ok} />);
    expect(screen.getByRole("button", { name: "Enviar a aprobación" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Anular" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Imprimir" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Guardar" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("Guarda los cambios antes de cambiar el estado")).toBeTruthy();
  });

  it("Anular asks for the reason and sends it", async () => {
    const onAction = vi.fn(ok);
    renderEs(<RecordActions entityType="documento" status="saved" flags={{ requiresApproval: false, posts: false }} rights={ALL} dirty={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Anular" }));
    const confirm = screen.getByRole("button", { name: "Confirmar" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "Pago duplicado" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("void", { reason: "Pago duplicado" }, undefined));
  });

  it("Eliminar asks to confirm", async () => {
    const onAction = vi.fn(ok);
    renderEs(<RecordActions entityType="documento" status="draft" flags={{ requiresApproval: false, posts: true }} rights={ALL} dirty={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Eliminar" }));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sí, eliminar" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith("delete", {}, undefined));
  });

  it("a refused action (a posting refusal) shows the reason as an inline alert under the bar", async () => {
    const onAction = vi.fn(async () => ({ ok: false as const, code: "period_closed", messages: ["El período 2026-10 está cerrado"] }));
    renderEs(<RecordActions entityType="documento" status="draft" flags={{ requiresApproval: false, posts: true }} rights={ALL} dirty onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("El período 2026-10 está cerrado");
  });

  it("Revertir sits next to Duplicar, and both are also under Más ▾", () => {
    renderEs(<RecordActions entityType="documento" status="posted" flags={{ requiresApproval: false, posts: true }} rights={ALL} dirty={false} tools={{ duplicate: true, reverse: true }} onAction={ok} />);
    expect(screen.getAllByRole("button", { name: "Revertir" }).length).toBeGreaterThan(0);
    const more = screen.getByRole("button", { name: /Más/ });
    fireEvent.click(more);
    expect(screen.getByRole("menuitem", { name: "Revertir" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Duplicar" })).toBeTruthy();
  });
});
