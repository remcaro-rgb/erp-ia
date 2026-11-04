// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordDialog, type PasswordChangeResult } from "../PasswordDialog";
import { renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// "Cambiar contraseña" of the user menu (owner decision 2026-11-04): the current password and the new one twice; the new
// ones are compared before anything is sent, the rest is the process's answer.

const open = (onChange = vi.fn(async (): Promise<PasswordChangeResult> => ({ ok: true }))) => {
  renderEs(<PasswordDialog open onOpenChange={vi.fn()} onChange={onChange} />);
  const box = screen.getByRole("dialog", { name: "Cambiar contraseña" });
  const fill = async (current: string, next: string, again: string) => {
    const user = userEvent.setup();
    await user.type(within(box).getByLabelText("Contraseña actual"), current);
    await user.type(within(box).getByLabelText("Contraseña nueva"), next);
    await user.type(within(box).getByLabelText("Repite la contraseña nueva"), again);
    return user;
  };
  return { box, fill, onChange };
};

describe("PasswordDialog", () => {
  it("sends the current and the new password and says it was changed", async () => {
    const { box, fill, onChange } = open();
    const user = await fill("vieja-clave-1", "nueva-clave-2", "nueva-clave-2");
    await user.click(within(box).getByRole("button", { name: "Cambiar contraseña" }));
    expect(onChange).toHaveBeenCalledWith("vieja-clave-1", "nueva-clave-2");
    await waitFor(() => expect(within(box).getByRole("status").textContent).toBe("Tu contraseña se cambió."));
    expect((within(box).getByLabelText("Contraseña actual") as HTMLInputElement).value).toBe("");
  });

  it("does not send when the two new passwords differ", async () => {
    const { box, fill, onChange } = open();
    const user = await fill("vieja-clave-1", "nueva-clave-2", "otra-clave-3");
    await user.click(within(box).getByRole("button", { name: "Cambiar contraseña" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(within(box).getByRole("alert").textContent).toBe("Las contraseñas nuevas no coinciden");
  });

  it("shows the process's reason when it refuses, and keeps what was typed", async () => {
    const onChange = vi.fn(async (): Promise<PasswordChangeResult> => ({ ok: false, code: "invalid_input", details: [{ message: "La contraseña actual no es correcta" }] }));
    const { box, fill } = open(onChange);
    const user = await fill("mala", "nueva-clave-2", "nueva-clave-2");
    await user.click(within(box).getByRole("button", { name: "Cambiar contraseña" }));
    await waitFor(() => expect(within(box).getByRole("alert").textContent).toBe("No se pudo cambiar: La contraseña actual no es correcta"));
    expect((within(box).getByLabelText("Contraseña nueva") as HTMLInputElement).value).toBe("nueva-clave-2");
  });

  it("the submit button waits for the two passwords to be typed", () => {
    const { box } = open();
    expect((within(box).getByRole("button", { name: "Cambiar contraseña" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
