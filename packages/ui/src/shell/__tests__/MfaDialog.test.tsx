// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "../AppShell";
import { MfaDialog, type MfaDisableResult } from "../MfaDialog";
import { memoryStorage, renderEs, stubLayoutApis } from "./intl";

beforeAll(stubLayoutApis);
afterEach(cleanup);

// "Verificación en dos pasos" in the user menu (design §22.19): the dialog shows whether the second step is on; when it
// is, "Desactivar" runs kernel.user.mfa.disable through the app's step-up flow (the prompt the app hands over shows
// inside the dialog); when it is not, "Activar" leads to /mfa/enroll. A role that requires the second step (system admin,
// not exempt) cannot turn it off and the dialog says so.

const dialog = (props: Partial<Parameters<typeof MfaDialog>[0]> = {}) => {
  const onDisable = vi.fn(async (): Promise<MfaDisableResult> => ({ ok: true }));
  const onOpenChange = vi.fn();
  renderEs(<MfaDialog open onOpenChange={onOpenChange} enrolled={false} requiredByRole={false} exempt={false} onDisable={onDisable} {...props} />);
  return { onDisable, onOpenChange, box: screen.getByRole("dialog", { name: "Verificación en dos pasos" }) };
};

describe("MfaDialog", () => {
  it("not set up: says so and Activar leads to /mfa/enroll; nothing to turn off", () => {
    const { box } = dialog();
    expect(box.textContent).toContain("No configurada");
    expect(within(box).getByRole("link", { name: "Activar" }).getAttribute("href")).toBe("/mfa/enroll");
    expect(within(box).queryByRole("button", { name: "Desactivar" })).toBeNull();
  });

  it("on: Desactivar runs the disable through the app, which shows its step-up prompt inside the dialog", async () => {
    let settle: (result: MfaDisableResult) => void = () => {};
    const onDisable = vi.fn(() => new Promise<MfaDisableResult>((resolve) => (settle = resolve)));
    const { rerender } = renderEs(<MfaDialog open onOpenChange={vi.fn()} enrolled requiredByRole={false} exempt={false} onDisable={onDisable} />);
    const box = screen.getByRole("dialog", { name: "Verificación en dos pasos" });
    expect(box.textContent).toContain("Activa");
    expect(within(box).queryByRole("link", { name: "Activar" })).toBeNull();
    await userEvent.setup().click(within(box).getByRole("button", { name: "Desactivar" }));
    expect(onDisable).toHaveBeenCalledTimes(1);
    // The app's flow asks for the code: its prompt renders in the dialog (a modal hides what is outside).
    rerender(<MfaDialog open onOpenChange={vi.fn()} enrolled requiredByRole={false} exempt={false} onDisable={onDisable} stepUpPrompt={<div>código aquí</div>} />);
    expect(within(screen.getByRole("dialog")).getByText("código aquí")).toBeTruthy();
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "Desactivar" }) as HTMLButtonElement).disabled).toBe(true);
    settle({ ok: true });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Segundo paso desactivado. Vuelve a ingresar con tu contraseña."));
  });

  it("a refusal shows the process's reason and lets the user try again", async () => {
    const onDisable = vi.fn(async (): Promise<MfaDisableResult> => ({ ok: false, code: "invalid_input", details: [{ message: "Tu rol exige la verificación en dos pasos; pídele a un administrador que te exima" }] }));
    const { box } = dialog({ enrolled: true, onDisable });
    fireEvent.click(within(box).getByRole("button", { name: "Desactivar" }));
    await waitFor(() => expect(within(box).getByRole("alert").textContent).toContain("Tu rol exige la verificación en dos pasos; pídele a un administrador que te exima"));
    expect((within(box).getByRole("button", { name: "Desactivar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a refusal without reasons names its code", async () => {
    const onDisable = vi.fn(async (): Promise<MfaDisableResult> => ({ ok: false, code: "step_up_required", details: [] }));
    const { box } = dialog({ enrolled: true, onDisable });
    fireEvent.click(within(box).getByRole("button", { name: "Desactivar" }));
    await waitFor(() => expect(within(box).getByRole("alert").textContent).toContain("Esta acción exige verificar tu segundo paso."));
  });

  it("a role that requires the second step: the note says so and Desactivar is off", () => {
    const { box, onDisable } = dialog({ enrolled: true, requiredByRole: true });
    expect(box.textContent).toContain("Tu rol exige la verificación en dos pasos");
    const off = within(box).getByRole("button", { name: "Desactivar" }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    fireEvent.click(off);
    expect(onDisable).not.toHaveBeenCalled();
  });

  it("an exempt user is told an administrator exempted them", () => {
    const { box } = dialog({ enrolled: true, exempt: true });
    expect(box.textContent).toContain("Un administrador te eximió");
    expect((within(box).getByRole("button", { name: "Desactivar" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Cerrar (the ✕ or the footer's) closes it", () => {
    const { box, onOpenChange } = dialog();
    const [cross, footer] = within(box).getAllByRole("button", { name: "Cerrar" });
    fireEvent.click(cross!);
    fireEvent.click(footer!);
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("the user menu", () => {
  const cafe = { id: "c1", name: "Café del Norte S.A.S.", taxId: "900373115" };
  const shell = (extra: Partial<Parameters<typeof AppShell>[0]> = {}) =>
    renderEs(
      <AppShell
        company={cafe}
        companies={[cafe]}
        user={{ id: "u1", name: "Marcela Rojas", email: "marcela@demo.local", roles: ["cajero"] }}
        modules={[{ id: "core", label: "nav.modules.core" }]}
        nav={[{ id: "core.parties", label: "nav.core.parties", href: "/parties", icon: "users" }]}
        currentHref="/parties"
        navigate={vi.fn()}
        storage={memoryStorage()}
        {...extra}
      >
        <p>contenido</p>
      </AppShell>,
    );

  it("offers Verificación en dos pasos, which opens the dialog with the session's state", async () => {
    shell({ mfa: { enrolled: false, requiredByRole: false, exempt: false }, onDisableMfa: vi.fn() });
    fireEvent.keyDown(screen.getByRole("button", { name: "Menú de usuario" }), { key: "Enter" });
    const item = screen.getByRole("menuitem", { name: /Verificación en dos pasos/ });
    expect(item.textContent).toContain("no configurada");
    fireEvent.click(item);
    const box = await screen.findByRole("dialog", { name: "Verificación en dos pasos" });
    expect(within(box).getByRole("link", { name: "Activar" }).getAttribute("href")).toBe("/mfa/enroll");
  });

  it("has no such item when the app does not wire it", () => {
    shell();
    fireEvent.keyDown(screen.getByRole("button", { name: "Menú de usuario" }), { key: "Enter" });
    expect(screen.queryByRole("menuitem", { name: /Verificación en dos pasos/ })).toBeNull();
  });
});
