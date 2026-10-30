// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderEs } from "../../shell/__tests__/intl";
import { StepUpPrompt } from "../StepUpPrompt";

afterEach(cleanup);

// UI density audit quick win 7 (M7): the inline step-up takes the caret, sends the code at the 6th digit (typed or
// pasted), Esc cancels, and a wrong code is cleared for the next try.

describe("StepUpPrompt", () => {
  it("takes the caret and sends the code at the 6th digit, once", async () => {
    const onConfirm = vi.fn();
    renderEs(<StepUpPrompt onConfirm={onConfirm} onCancel={vi.fn()} error={null} />);
    const box = screen.getByLabelText("Código de 6 dígitos");
    expect(document.activeElement).toBe(box);
    const user = userEvent.setup();
    await user.keyboard("12345");
    expect(onConfirm).not.toHaveBeenCalled();
    await user.keyboard("6");
    expect(onConfirm).toHaveBeenCalledWith("123456");
    // Enter or the button do not send the same code a second time.
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Verificar" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("a pasted code with spaces is sent as its 6 digits", async () => {
    const onConfirm = vi.fn();
    renderEs(<StepUpPrompt onConfirm={onConfirm} onCancel={vi.fn()} error={null} />);
    const user = userEvent.setup();
    await user.paste("482 193");
    expect(onConfirm).toHaveBeenCalledWith("482193");
  });

  it("Esc cancels", async () => {
    const onCancel = vi.fn();
    renderEs(<StepUpPrompt onConfirm={vi.fn()} onCancel={onCancel} error={null} />);
    await userEvent.setup().keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("after a refused code the box is emptied and keeps the caret for the next try", async () => {
    const onConfirm = vi.fn();
    const { rerender } = renderEs(<StepUpPrompt onConfirm={onConfirm} onCancel={vi.fn()} error={null} busy={false} />);
    const user = userEvent.setup();
    await user.keyboard("000000");
    rerender(<StepUpPrompt onConfirm={onConfirm} onCancel={vi.fn()} error={null} busy />);
    rerender(<StepUpPrompt onConfirm={onConfirm} onCancel={vi.fn()} error="invalid_code" busy={false} />);
    const box = screen.getByLabelText("Código de 6 dígitos") as HTMLInputElement;
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
    expect(screen.getByRole("alert")).toBeTruthy();
    // The same wrong code again (the error does not change): still cleared.
    await user.keyboard("000000");
    expect(onConfirm).toHaveBeenCalledTimes(2);
    rerender(<StepUpPrompt onConfirm={onConfirm} onCancel={vi.fn()} error="invalid_code" busy />);
    rerender(<StepUpPrompt onConfirm={onConfirm} onCancel={vi.fn()} error="invalid_code" busy={false} />);
    expect(box.value).toBe("");
  });
});

// Design §22.19, Review Focus 5: a user who turned their second step off (or never set it up) cannot produce a code; the
// prompt says how to turn it on again, with the way there, instead of a bare "the code is not valid".
describe("StepUpPrompt without a second step", () => {
  it("says to activate it from the user menu and links to /mfa/enroll", () => {
    const onCancel = vi.fn();
    renderEs(<StepUpPrompt onConfirm={vi.fn()} onCancel={onCancel} error="no_factor" />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Activa la verificación en dos pasos en tu menú de usuario para ejecutar esta acción");
    expect(alert.textContent).not.toContain("El código no es válido");
    const link = screen.getByRole("link", { name: "Activarla ahora" });
    expect(link.getAttribute("href")).toBe("/mfa/enroll");
    // There is no code to type: only Cancelar is left.
    expect(screen.queryByLabelText("Código de 6 dígitos")).toBeNull();
    screen.getByRole("button", { name: "Cancelar" }).click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
