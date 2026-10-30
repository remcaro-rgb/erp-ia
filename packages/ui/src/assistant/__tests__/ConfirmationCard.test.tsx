// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { ConfirmationCard } from "../ConfirmationCard";
import { renderEs } from "../../shell/__tests__/intl";

// The confirmation card of the assistant (design §7.1, rules 15 and 17, prototype v5 `.confirm`): the proposal with its
// effects, and the three decisions. A write never runs from the chat without it; a step-up process also asks for the
// 6-digit code here, in the chat.

afterEach(cleanup);

const preview = {
  title: "Crea un tercero",
  effects: [
    { label: "Razón social", value: "Café del Norte S.A.S." },
    { label: "NIT", value: "900373115" },
    { label: "Ciudad", value: "Bogotá" },
  ],
  permission: "core.party.create",
  stepUp: false,
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ConfirmationCard", () => {
  it("shows the title, every effect row and the permission, and confirms with onDecide('confirm')", () => {
    const onDecide = vi.fn();
    renderEs(<ConfirmationCard processId="core.party.create" preview={preview} onDecide={onDecide} />);
    expect(screen.getByText("Crea un tercero")).toBeTruthy();
    for (const effect of preview.effects) {
      expect(screen.getByText(effect.label)).toBeTruthy();
      expect(screen.getByText(effect.value)).toBeTruthy();
    }
    expect(screen.getByText(/core\.party\.create/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(onDecide).toHaveBeenCalledWith("confirm", undefined);
  });

  it("Cancelar decides 'reject'", () => {
    const onDecide = vi.fn();
    renderEs(<ConfirmationCard processId="core.party.create" preview={preview} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onDecide).toHaveBeenCalledWith("reject");
  });

  it("with stepUp, Confirmar stays disabled until a 6-digit code is verified at /api/auth/step-up, and the token goes with the confirm", async () => {
    const onDecide = vi.fn();
    const fetcher = vi.fn(async () => json({ token: "tok-123" }));
    renderEs(<ConfirmationCard processId="core.party.update_credit" preview={{ ...preview, stepUp: true }} onDecide={onDecide} fetcher={fetcher as unknown as typeof fetch} />);
    const confirm = screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);

    const code = screen.getByLabelText("Código de verificación");
    fireEvent.change(code, { target: { value: "12345" } });
    expect((screen.getByRole("button", { name: "Verificar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(confirm.disabled).toBe(true);

    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(fetcher).toHaveBeenCalledWith("/api/auth/step-up", expect.objectContaining({ method: "POST", body: JSON.stringify({ code: "123456" }) }));

    fireEvent.click(confirm);
    expect(onDecide).toHaveBeenCalledWith("confirm", "tok-123");
  });

  it("with stepUp and no second step, the card says to activate it from the user menu and links to /mfa/enroll", async () => {
    const fetcher = vi.fn(async () => json({ code: "no_factor" }, 409));
    renderEs(<ConfirmationCard processId="p" preview={{ ...preview, stepUp: true }} onDecide={vi.fn()} fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.change(screen.getByLabelText("Código de verificación"), { target: { value: "123456" } });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Activa la verificación en dos pasos en tu menú de usuario para ejecutar esta acción");
    expect(screen.getByRole("link", { name: "Activarla ahora" }).getAttribute("href")).toBe("/mfa/enroll");
  });

  it("the token is single use: after a confirm (refused or not) the next attempt asks for a fresh code", async () => {
    const onDecide = vi.fn();
    const fetcher = vi.fn(async () => json({ token: "tok-1" }));
    renderEs(<ConfirmationCard processId="p" preview={{ ...preview, stepUp: true }} onDecide={onDecide} fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.change(screen.getByLabelText("Código de verificación"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar" }));
    expect(onDecide).toHaveBeenCalledWith("confirm", "tok-1");
    // The confirm failed (the card is still pending): Confirmar waits for a new verification.
    expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Código de verificación") as HTMLInputElement).value).toBe("");
  });

  it("entering Editar drops the verified code: coming back needs a new verification", async () => {
    const fetcher = vi.fn(async () => json({ token: "tok-1" }));
    renderEs(<ConfirmationCard processId="p" preview={{ ...preview, stepUp: true }} onDecide={vi.fn()} onEdit={vi.fn()} fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.change(screen.getByLabelText("Código de verificación"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.click(screen.getByRole("button", { name: "Volver" }));
    expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Verificado")).toBeNull();
  });

  it("a wrong code keeps Confirmar disabled and says so", async () => {
    const fetcher = vi.fn(async () => json({ code: "invalid_code", details: null }, 401));
    renderEs(<ConfirmationCard processId="p" preview={{ ...preview, stepUp: true }} onDecide={vi.fn()} fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.change(screen.getByLabelText("Código de verificación"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/incorrecto/i));
    expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Editar changes effect values inline and sends them as a new message, never as a decision", () => {
    const onDecide = vi.fn();
    const onEdit = vi.fn();
    renderEs(<ConfirmationCard processId="core.party.create" preview={preview} onDecide={onDecide} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    fireEvent.change(screen.getByLabelText("Ciudad"), { target: { value: "Medellín" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar cambios" }));
    expect(onEdit).toHaveBeenCalledWith("Cambia Ciudad a Medellín");
    expect(onDecide).not.toHaveBeenCalled();
  });

  it("an edit that changes nothing sends nothing", () => {
    const onEdit = vi.fn();
    renderEs(<ConfirmationCard processId="p" preview={preview} onDecide={vi.fn()} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect((screen.getByRole("button", { name: "Enviar cambios" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an executed card keeps its final state and no buttons", () => {
    renderEs(<ConfirmationCard processId="p" preview={preview} state={{ status: "executed" }} onDecide={vi.fn()} />);
    expect(screen.getByText(/Listo/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  it("a rejected card says nothing changed, and an expired one says why", () => {
    const { unmount } = renderEs(<ConfirmationCard processId="p" preview={preview} state={{ status: "rejected" }} onDecide={vi.fn()} />);
    expect(screen.getByText(/nada cambió/i)).toBeTruthy();
    unmount();
    renderEs(<ConfirmationCard processId="p" preview={preview} state={{ status: "rejected", reason: "confirmation_expired" }} onDecide={vi.fn()} />);
    expect(screen.getByText(/venció/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirmar" })).toBeNull();
  });

  it("a refused confirmation shows the reason and the card stays confirmable", () => {
    renderEs(<ConfirmationCard processId="p" preview={preview} state={{ status: "pending", error: "forbidden" }} onDecide={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toMatch(/permiso/i);
    expect((screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables the buttons while the confirmation runs", () => {
    renderEs(<ConfirmationCard processId="p" preview={preview} state={{ status: "confirming" }} onDecide={vi.fn()} />);
    expect((screen.getByRole("button", { name: /Confirmar|Procesando/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Cancelar" }) as HTMLButtonElement).disabled).toBe(true);
  });

  // UI density audit quick win 7 (M7): the code box takes the caret, the 6th digit verifies, and once verified the
  // caret moves to Confirmar.
  it("with stepUp the code box takes the caret, the 6th digit verifies, and Confirmar takes the caret", async () => {
    const onDecide = vi.fn();
    const fetcher = vi.fn(async () => json({ token: "tok-9" }));
    renderEs(<ConfirmationCard processId="p" preview={{ ...preview, stepUp: true }} onDecide={onDecide} fetcher={fetcher as unknown as typeof fetch} />);
    const code = screen.getByLabelText("Código de verificación");
    expect(document.activeElement).toBe(code);
    fireEvent.change(code, { target: { value: "65432" } });
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.change(code, { target: { value: "654321" } });
    const confirm = screen.getByRole("button", { name: "Confirmar" }) as HTMLButtonElement;
    await waitFor(() => expect(confirm.disabled).toBe(false));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ code: "654321" });
    await waitFor(() => expect(document.activeElement).toBe(confirm));
    fireEvent.click(confirm);
    expect(onDecide).toHaveBeenCalledWith("confirm", "tok-9");
  });

  it("does not steal the caret from a field the user is typing in", () => {
    const outside = document.createElement("input");
    document.body.append(outside);
    outside.focus();
    try {
      renderEs(<ConfirmationCard processId="p" preview={{ ...preview, stepUp: true }} onDecide={vi.fn()} />);
      expect(document.activeElement).toBe(outside);
    } finally {
      outside.remove();
    }
  });

  // Branch review fix 8: a code copied with spaces ("482 193") verifies, as in the form's prompt.
  it("a pasted code with spaces is verified as its 6 digits", async () => {
    const fetcher = vi.fn(async () => json({ token: "tok-p" }));
    renderEs(<ConfirmationCard processId="p" preview={{ ...preview, stepUp: true }} onDecide={vi.fn()} fetcher={fetcher as unknown as typeof fetch} />);
    fireEvent.paste(screen.getByLabelText("Código de verificación"), { clipboardData: { getData: () => "482 193" } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ code: "482193" });
    expect((screen.getByLabelText("Código de verificación") as HTMLInputElement).value).toBe("482193");
  });
});
