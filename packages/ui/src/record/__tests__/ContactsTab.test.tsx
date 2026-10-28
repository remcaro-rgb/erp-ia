// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ContactsTab, contactProblems, emptyDraft, type ContactItem } from "../../index";

afterEach(cleanup);

const ana: ContactItem = {
  id: "c1",
  name: "Ana Gómez",
  jobTitle: "Tesorera",
  email: "ana@exito.com",
  phoneCc: "57",
  phone: "6015550000",
  ext: "123",
  mobileCc: "57",
  mobile: "3001234567",
};

const setup = (props: Partial<Parameters<typeof ContactsTab>[0]> = {}) => {
  const handlers = { onCreate: vi.fn().mockResolvedValue(undefined), onUpdate: vi.fn().mockResolvedValue(undefined), onRemove: vi.fn().mockResolvedValue(undefined) };
  render(<ContactsTab contacts={[ana]} {...handlers} {...props} />);
  return handlers;
};

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("ContactsTab", () => {
  it("lists the contacts with their formatted phones", () => {
    setup();
    const row = screen.getByText("Ana Gómez").closest("tr")!;
    for (const text of ["Tesorera", "ana@exito.com", "+57 6015550000", "123", "+57 3001234567"]) expect(within(row).getByText(text)).toBeTruthy();
  });

  it("says so when there are no contacts", () => {
    setup({ contacts: [] });
    expect(screen.getByText(/Sin contactos/)).toBeTruthy();
  });

  it("adds a contact: validates e-mail and phones inline and asks for a channel", async () => {
    const { onCreate } = setup({ contacts: [] });
    fireEvent.click(screen.getByRole("button", { name: "+ Nuevo contacto" }));
    const save = screen.getByRole("button", { name: "Agregar contacto" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fill("Nombre", "Luis Pérez");
    expect(save.disabled).toBe(true);
    fill("Correo", "luis@");
    expect(screen.getByText("Correo inválido (nombre@dominio.ext)")).toBeTruthy();
    expect(save.disabled).toBe(true);
    fill("Correo", "luis@exito.com");
    fill("Celular", "123");
    expect(screen.getByText("Colombia: celular 10 dígitos (3…) o fijo 10 dígitos (60…)")).toBeTruthy();
    expect(save.disabled).toBe(true);
    fill("Celular", "3001234567");
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith({ name: "Luis Pérez", jobTitle: "", email: "luis@exito.com", phoneCc: "57", phone: "", ext: "", mobileCc: "57", mobile: "3001234567" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Agregar contacto" })).toBeNull());
  });

  it("edits a contact in the same form and reports its id", async () => {
    const { onUpdate } = setup();
    fireEvent.click(screen.getByText("Ana Gómez"));
    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Ana Gómez");
    fill("Cargo", "Gerente financiera");
    fireEvent.click(screen.getByRole("button", { name: "Guardar contacto" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith("c1", { name: "Ana Gómez", jobTitle: "Gerente financiera", email: "ana@exito.com", phoneCc: "57", phone: "6015550000", ext: "123", mobileCc: "57", mobile: "3001234567" });
  });

  it("opens a contact from the keyboard through the button on its name", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Ana Gómez" }));
    expect((screen.getByLabelText("Nombre") as HTMLInputElement).value).toBe("Ana Gómez");
  });

  it("asks for confirmation before removing, and No keeps the contact", async () => {
    const { onRemove } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Quitar a Ana Gómez" }));
    expect(screen.getByText(/¿Quitar a/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    expect(onRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Quitar a Ana Gómez" }));
    fireEvent.click(screen.getByRole("button", { name: "Sí, quitar" }));
    await waitFor(() => expect(onRemove).toHaveBeenCalledWith("c1"));
  });

  it("keeps the form open and shows the reason when the server refuses", async () => {
    const { onCreate } = setup({ contacts: [], onCreate: vi.fn().mockRejectedValue(new Error("Ya existe ese correo")) });
    void onCreate;
    fireEvent.click(screen.getByRole("button", { name: "+ Nuevo contacto" }));
    fill("Nombre", "Luis");
    fill("Correo", "luis@exito.com");
    fireEvent.click(screen.getByRole("button", { name: "Agregar contacto" }));
    expect((await screen.findByRole("alert")).textContent).toBe("No se pudo guardar el contacto: Ya existe ese correo");
    expect(screen.getByRole("button", { name: "Agregar contacto" })).toBeTruthy();
  });

  it("offers Verificar for a contact's valid e-mail and phones when asked to", () => {
    const onVerify = vi.fn();
    setup({ contacts: [], verify: { onVerify } });
    fireEvent.click(screen.getByRole("button", { name: "+ Nuevo contacto" }));
    fill("Correo", "luis@exito.com");
    fireEvent.click(screen.getByRole("button", { name: "Verificar ↗" }));
    expect(onVerify).toHaveBeenCalledWith("email", "luis@exito.com");
  });

  it("is read-only when asked", () => {
    setup({ readOnly: true });
    expect(screen.queryByRole("button", { name: "+ Nuevo contacto" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quitar a Ana Gómez" })).toBeNull();
    fireEvent.click(screen.getByText("Ana Gómez"));
    expect(screen.queryByLabelText("Nombre")).toBeNull();
  });
});

describe("ContactsTab capabilities", () => {
  it("shows only the controls whose callback it was given (a role may create but not remove)", () => {
    render(<ContactsTab contacts={[ana]} onCreate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "+ Nuevo contacto" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Quitar a Ana Gómez" })).toBeNull();
    fireEvent.click(screen.getByText("Ana Gómez"));
    expect(screen.queryByLabelText("Nombre")).toBeNull();
    cleanup();
    render(<ContactsTab contacts={[ana]} onUpdate={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "+ Nuevo contacto" })).toBeNull();
    expect(screen.getByRole("button", { name: "Quitar a Ana Gómez" })).toBeTruthy();
    fireEvent.click(screen.getByText("Ana Gómez"));
    expect(screen.getByLabelText("Nombre")).toBeTruthy();
  });

  it("shows the queued status the verify hook reports next to the e-mail", () => {
    const onVerify = vi.fn();
    render(<ContactsTab contacts={[]} onCreate={vi.fn()} verify={{ onVerify, statusOf: (kind, value) => (kind === "email" && value === "luis@exito.com" ? "queued" : undefined) }} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Nuevo contacto" }));
    fill("Correo", "luis@exito.com");
    expect(screen.getByText("en cola")).toBeTruthy();
  });
});

describe("ContactsTab verification", () => {
  const open = (verify: NonNullable<Parameters<typeof ContactsTab>[0]["verify"]>) => {
    render(<ContactsTab contacts={[]} onCreate={vi.fn()} verify={verify} />);
    fireEvent.click(screen.getByRole("button", { name: "+ Nuevo contacto" }));
    fill("Correo", "luis@exito.com");
  };

  it("disables Verificar while the request is in flight and once the datum is queued: no spam", async () => {
    let finish: () => void = () => {};
    const onVerify = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    open({ onVerify });
    const button = () => screen.getByRole("button", { name: "Verificar ↗" }) as HTMLButtonElement;
    fireEvent.click(button());
    fireEvent.click(button());
    expect(onVerify).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    finish();
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it("keeps Verificar disabled for a queued or verified datum, and enabled again after a failure", () => {
    const status = { value: "queued" as "queued" | "verified" | "failed" };
    open({ onVerify: vi.fn(), statusOf: () => status.value });
    expect((screen.getByRole("button", { name: "Verificar ↗" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    status.value = "failed";
    open({ onVerify: vi.fn(), statusOf: () => status.value });
    expect((screen.getByRole("button", { name: "Verificar ↗" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("a rejected onVerify is shown, not thrown as an unhandled rejection, and the button comes back", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const onVerify = vi.fn().mockRejectedValue(new Error("sin red"));
    open({ onVerify });
    fireEvent.click(screen.getByRole("button", { name: "Verificar ↗" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("sin red"));
    expect((screen.getByRole("button", { name: "Verificar ↗" }) as HTMLButtonElement).disabled).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});

describe("contactProblems", () => {
  it("needs a name and at least one channel, and checks each datum", () => {
    expect(contactProblems(emptyDraft())).toMatchObject({ name: expect.any(String) });
    expect(contactProblems({ ...emptyDraft(), name: "A" })).toMatchObject({ channel: "Indica al menos un correo o teléfono" });
    expect(contactProblems({ ...emptyDraft(), name: "A", email: "a@b.co" })).toEqual({});
    expect(contactProblems({ ...emptyDraft(), name: "A", phone: "12" }).phone).toBeTruthy();
    expect(contactProblems({ ...emptyDraft(), name: "A", mobileCc: "1", mobile: "2025550123" })).toEqual({});
  });
});
