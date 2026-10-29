// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { PartyForm } from "../PartyForm";
import type { PartyTables } from "../party-form-model";
import type { SaveRecord } from "../save-model";

afterEach(cleanup);

// The party form (design §5.8a, §5.18, prototype renderPartyForm / pfSet / savePartyForm): the DIAN sections, the
// check digit computed live with the pack's algorithm, both e-mails for a party that is customer and supplier, the
// save through the party processes with their messages, and the step-up when the process asks for it.

const tables: PartyTables = {
  documentTypes: [
    { code: "13", name: "Cédula de ciudadanía", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
    { code: "31", name: "NIT", charset: "num", maxLength: 10, personTypes: ["1", "2"], foreign: false },
    { code: "41", name: "Pasaporte", charset: "alnum", maxLength: 20, personTypes: ["2"], foreign: true },
    { code: "50", name: "NIT de otro país", charset: "alnum", maxLength: 20, personTypes: ["1"], foreign: true },
  ],
  responsibilities: [
    { code: "O-13", name: "Gran contribuyente" },
    { code: "O-23", name: "Agente de retención IVA" },
    { code: "R-99-PN", name: "No responsable · no aplica" },
  ],
  exclusiveResponsibility: "R-99-PN",
  taxSchemes: [
    { code: "01", name: "IVA" },
    { code: "ZZ", name: "No aplica" },
  ],
  countries: [
    { code: "CO", name: "Colombia" },
    { code: "US", name: "Estados Unidos" },
  ],
  homeCountry: "CO",
  departments: [
    { code: "05", name: "Antioquia" },
    { code: "11", name: "Bogotá, D.C." },
  ],
  municipalities: [
    { code: "05001", name: "Medellín", departmentCode: "05" },
    { code: "11001", name: "Bogotá, D.C.", departmentCode: "11" },
  ],
  checkDigitTypes: ["31"],
  preferredDocumentType: { home: { "1": "31", "2": "13" }, abroad: { "1": "50", "2": "41" } },
  limits: { legalName: 450, namePart: 60, address: 200 },
};

const setup = (props: Partial<Parameters<typeof PartyForm>[0]> = {}) => {
  const save = vi.fn<SaveRecord>(async () => ({ ok: true, id: "0192f000-0000-7000-8000-000000000001" }));
  const onSaved = vi.fn();
  renderEs(<PartyForm record={null} tables={tables} modes={{}} save={save} onSaved={onSaved} {...props} />);
  return { save, onSaved };
};

/** The control whose label starts with `label` (labels carry hints after the name). */
const field = (label: string) => screen.getByLabelText(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), { selector: "input,select" }) as HTMLInputElement;

describe("PartyForm started from a copy (rule 37)", () => {
  it("a new party starts from the copy's values, without a NIT, and is created without an id", async () => {
    const initial = { kind: ["customer"], person_type: "1", document_type: "31", legal_name: "Almacenes Éxito S.A.", tax_responsibilities: ["O-13"], tax_scheme: "01", country_code: "CO", department_code: "11", municipality_code: "11001", invoice_email: "fe@exito.com" };
    const { save, onSaved } = setup({ initial });
    expect(field("Razón social").value).toBe("Almacenes Éxito S.A.");
    expect(field("Número").value).toBe("");
    fireEvent.change(field("Número"), { target: { value: "860002964" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const input = save.mock.calls[0]![0];
    expect(input).not.toHaveProperty("id");
    expect(input).toMatchObject({ documentNumber: "860002964", legalName: "Almacenes Éxito S.A.", taxResponsibilities: ["O-13"], invoiceEmail: "fe@exito.com" });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("0192f000-0000-7000-8000-000000000001", true));
  });
});

describe("PartyForm location comboboxes", () => {
  it("department and municipality are typeahead boxes: the municipality list follows the department, and the choice is saved by code", async () => {
    const initial = { kind: ["customer"], person_type: "1", document_type: "31", legal_name: "Café del Norte S.A.S.", tax_responsibilities: ["O-13"], tax_scheme: "01", country_code: "CO", department_code: "11", municipality_code: "11001", invoice_email: "fe@cafedelnorte.co" };
    const { save } = setup({ initial });
    fireEvent.change(field("Número"), { target: { value: "900373115" } });
    const department = screen.getByRole("combobox", { name: /^Departamento/ });
    const municipality = screen.getByRole("combobox", { name: /^Municipio/ });
    expect((department as HTMLInputElement).value).toBe("Bogotá, D.C.");
    fireEvent.change(department, { target: { value: "antio" } });
    fireEvent.keyDown(department, { key: "Enter" });
    expect((department as HTMLInputElement).value).toBe("Antioquia");
    // Changing the department clears a municipality that belongs to another.
    expect((municipality as HTMLInputElement).value).toBe("");
    fireEvent.change(municipality, { target: { value: "bogota" } });
    expect(screen.getByText("Sin coincidencias")).toBeTruthy();
    fireEvent.change(municipality, { target: { value: "medellin" } });
    fireEvent.keyDown(municipality, { key: "Enter" });
    expect((municipality as HTMLInputElement).value).toBe("Medellín");
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ departmentCode: "05", municipalityCode: "05001" });
  });
});

describe("PartyForm", () => {
  it("computes the NIT check digit live with the DIAN algorithm", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Identificación" })).toBeTruthy();
    fireEvent.change(field("Número"), { target: { value: "900373115" } });
    expect((screen.getByLabelText("DV") as HTMLInputElement).value).toBe("3");
    fireEvent.change(field("Número"), { target: { value: "860002964" } });
    expect((screen.getByLabelText("DV") as HTMLInputElement).value).toBe("4");
    // Letters in a numeric document: flagged while typing, and the save stays off.
    fireEvent.change(field("Número"), { target: { value: "90037A" } });
    expect(screen.getByText("Solo dígitos")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Crear" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("Ambos shows two e-mails; one relation shows its own", () => {
    setup();
    expect(screen.getByLabelText(/Correo de recepción de facturas de venta/)).toBeTruthy();
    expect(screen.queryByLabelText(/Correo para enviar documentos al proveedor/)).toBeNull();
    fireEvent.change(field("Relación"), { target: { value: "both" } });
    expect(screen.getByLabelText(/Correo de recepción de facturas de venta/)).toBeTruthy();
    expect(screen.getByLabelText(/Correo para enviar documentos al proveedor/)).toBeTruthy();
    expect(screen.getByText(/Al ser cliente y proveedor se piden los dos correos/)).toBeTruthy();
    fireEvent.change(field("Relación"), { target: { value: "supplier" } });
    expect(screen.queryByLabelText(/Correo de recepción de facturas de venta/)).toBeNull();
  });

  it("a natural person gives surnames and names, composed for documents; abroad there are no DANE codes", () => {
    setup();
    fireEvent.change(field("Tipo de persona"), { target: { value: "2" } });
    // NIT applies to both, but the prototype moves a natural person to the cédula.
    expect(field("Tipo de documento").value).toBe("13");
    fireEvent.change(field("Primer apellido"), { target: { value: "Pérez" } });
    fireEvent.change(field("Primer nombre"), { target: { value: "Carlos" } });
    expect(field("Nombre para documentos").value).toBe("Pérez Carlos");
    expect(screen.queryByLabelText("Razón social", { selector: "input" })).toBeNull();
    fireEvent.change(field("País"), { target: { value: "US" } });
    expect(field("Tipo de documento").value).toBe("41");
    expect(screen.queryByLabelText("Departamento", { selector: "input" })).toBeNull();
  });

  it("R-99-PN excludes the other responsibilities, and the RUT summary follows them", () => {
    setup();
    const check = (code: string) => screen.getByRole("checkbox", { name: new RegExp(code) }) as HTMLInputElement;
    expect(check("R-99-PN").checked).toBe(true);
    fireEvent.click(check("O-23"));
    expect(check("R-99-PN").checked).toBe(false);
    expect(screen.getByText("Agente de retención: aplicar retención de IVA en compras.")).toBeTruthy();
    fireEvent.click(check("R-99-PN"));
    expect(check("O-23").checked).toBe(false);
  });

  it("saves through the process and shows its invalid_input messages in the DIAN panel", async () => {
    const save = vi.fn<SaveRecord>(async () => ({ ok: false, code: "invalid_input", details: [{ message: "Ya existe un tercero con documento 31 900373115" }] }));
    const { onSaved } = setup({ save });
    fireEvent.change(field("Número"), { target: { value: "900373115" } });
    fireEvent.change(field("Razón social"), { target: { value: "Café del Norte S.A.S." } });
    fireEvent.change(field("Relación"), { target: { value: "both" } });
    fireEvent.change(screen.getByLabelText(/Correo de recepción de facturas de venta/), { target: { value: "fe@cafedelnorte.co" } });
    fireEvent.change(screen.getByLabelText(/Correo para enviar documentos al proveedor/), { target: { value: "compras@cafedelnorte.co" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
      kind: ["customer", "supplier"],
      personType: "1",
      documentType: "31",
      documentNumber: "900373115",
      legalName: "Café del Norte S.A.S.",
      taxResponsibilities: ["R-99-PN"],
      countryCode: "CO",
      invoiceEmail: "fe@cafedelnorte.co",
      supplierEmail: "compras@cafedelnorte.co",
    });
    const panel = await screen.findByText("1 error impide guardar");
    expect(within(panel.closest("div")!).getByText("Ya existe un tercero con documento 31 900373115")).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("shows a process message about one input field under that field, and the pack's messages in the panel", async () => {
    const save = vi.fn<SaveRecord>(async () => ({
      ok: false,
      code: "invalid_input",
      details: [
        { path: ["legalName"], message: "La razón social es demasiado larga" },
        { path: ["invoiceEmail"], message: "Correo rechazado por el proceso" },
        { path: ["taxResponsibilities", "0"], message: "Responsabilidad desconocida" },
        { message: "Municipio DANE inválido" },
      ],
    }));
    setup({ save });
    fireEvent.change(field("Número"), { target: { value: "900373115" } });
    fireEvent.change(field("Razón social"), { target: { value: "Café del Norte S.A.S." } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    const message = await screen.findByText("La razón social es demasiado larga");
    // Under its own field, which is flagged.
    expect(message.closest(".erp-field")!.querySelector("input")!.getAttribute("aria-invalid")).toBe("true");
    expect(within(message.closest(".erp-field")!).getByText(/^Razón social/)).toBeTruthy();
    expect(screen.getByText("Correo rechazado por el proceso").closest(".erp-field-wrap")!.textContent).toMatch(/Correo de recepción de facturas de venta/);
    // The panel keeps the pack's message and the one about a field the form has no slot for.
    const panel = screen.getByText("2 errores impiden guardar").closest("div")!;
    expect(within(panel).getByText("Municipio DANE inválido")).toBeTruthy();
    expect(within(panel).getByText("taxResponsibilities.0: Responsabilidad desconocida")).toBeTruthy();
    expect(within(panel).queryByText("La razón social es demasiado larga")).toBeNull();
  });

  it("asks for the step-up code when the process requires it and saves again with the token", async () => {
    const save = vi
      .fn<SaveRecord>()
      .mockResolvedValueOnce({ ok: false, code: "step_up_required", details: [] })
      .mockResolvedValueOnce({ ok: true, id: "0192f000-0000-7000-8000-000000000002" });
    const requestStepUp = vi.fn(async () => ({ token: "tok-1" }));
    const record = { id: "0192f000-0000-7000-8000-000000000002", kind: ["customer"], person_type: "1", document_type: "31", document_number: "900373115", legal_name: "Café del Norte S.A.S.", tax_responsibilities: ["O-13"], tax_scheme: "01", country_code: "CO", credit_limit: "5000000.0000", dian_status: "missing: 1", dian_missing: ["Dirección"], invoice_ready: false, is_active: true };
    const { onSaved } = setup({ save, requestStepUp, record, modes: { credit_limit: "visible", balance: "masked" } });
    // The stored record's pending data and why it cannot be invoiced.
    expect(screen.getByText("Se puede guardar, pero faltan 1 datos para facturación electrónica / exógena")).toBeTruthy();
    expect(screen.getByText("✕ No se puede usar en facturas")).toBeTruthy();
    // Money as $ 1.234.567,00; the masked balance is not shown.
    expect((screen.getByLabelText("Cupo de crédito") as HTMLInputElement).value).toBe("$ 5.000.000,00");
    expect((screen.getByLabelText("Saldo") as HTMLInputElement).value).toBe("••••••");
    fireEvent.change(field("Dirección"), { target: { value: "Cll 80 No. 10-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    const code = await screen.findByLabelText("Código de 6 dígitos");
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verificar" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(requestStepUp).toHaveBeenCalledWith("123456");
    expect(save.mock.calls[1]![1]).toBe("tok-1");
    expect(save.mock.calls[1]![0]).toMatchObject({ addressLine: "Cll 80 No. 10-20", creditLimit: 5_000_000 });
    expect(onSaved).toHaveBeenCalledWith("0192f000-0000-7000-8000-000000000002", false);
  });

  // UI density audit quick win 6 (H5): a real <form>, Ctrl/⌘+S and Ctrl/⌘+Enter save, the caret goes to the first field
  // in error after a refusal, hints and errors are linked with aria-describedby, and one alert speaks for the form.
  it("is a form that saves with Ctrl+S or ⌘+Enter, and Enter alone never submits", async () => {
    const { save } = setup();
    const form = field("Número").closest("form")!;
    expect(form.className).toContain("erp-form");
    expect(form.getAttribute("aria-keyshortcuts")).toBe("Control+S Meta+S Control+Enter Meta+Enter");
    fireEvent.change(field("Número"), { target: { value: "900373115" } });
    fireEvent.change(field("Razón social"), { target: { value: "Café del Norte S.A.S." } });
    fireEvent.keyDown(field("Razón social"), { key: "Enter" });
    expect(save).not.toHaveBeenCalled();
    const ctrlS = fireEvent.keyDown(field("Razón social"), { key: "s", ctrlKey: true });
    // The browser's own "save page" is suppressed.
    expect(ctrlS).toBe(false);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(field("Número"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Ctrl+S guarda")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Crear" }).getAttribute("aria-keyshortcuts")).toBe("Control+S Meta+S Control+Enter Meta+Enter");
  });

  it("after a refusal puts the caret on the first field in error, or on the summary when no field is named", async () => {
    const save = vi
      .fn<SaveRecord>()
      .mockResolvedValueOnce({ ok: false, code: "invalid_input", details: [{ path: ["legalName"], message: "La razón social es demasiado larga" }] })
      .mockResolvedValueOnce({ ok: false, code: "invalid_input", details: [{ message: "Ya existe un tercero con documento 31 900373115" }] });
    setup({ save });
    fireEvent.change(field("Número"), { target: { value: "900373115" } });
    fireEvent.change(field("Razón social"), { target: { value: "Café del Norte S.A.S." } });
    fireEvent.keyDown(field("Número"), { key: "s", ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(field("Razón social")));
    // The message describes the field; it is not an alert of its own.
    const describedBy = field("Razón social").getAttribute("aria-describedby")!.split(" ");
    expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain("La razón social es demasiado larga");
    expect(screen.queryAllByRole("alert").map((a) => a.textContent)).not.toContain("La razón social es demasiado larga");
    fireEvent.keyDown(field("Número"), { key: "s", metaKey: true });
    const panel = await screen.findByText("1 error impide guardar");
    await waitFor(() => expect(document.activeElement).toBe(panel.closest("[data-error-summary]")));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("links a field's hint with aria-describedby, and Ctrl+S on a blocked form goes to the problem instead of saving", () => {
    const { save } = setup();
    // The schema hints are off until "Ver códigos DIAN" is turned on (OD-12).
    expect(field("Tipo de persona").getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByText("AdditionalAccountID")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Ver códigos DIAN" }));
    const personType = field("Tipo de persona");
    const hint = document.getElementById(personType.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toContain("AdditionalAccountID");
    // NIT with letters: the client check blocks the save.
    fireEvent.change(field("Número"), { target: { value: "90037311A" } });
    field("Razón social").focus();
    fireEvent.keyDown(field("Razón social"), { key: "s", ctrlKey: true });
    expect(save).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(field("Número"));
  });

  // Branch review fix 1: a pending or verifying step-up is not a second chance to submit without the token.
  it("Ctrl+S while the step-up is pending or verifying does not save again", async () => {
    const save = vi.fn<SaveRecord>().mockResolvedValueOnce({ ok: false, code: "step_up_required", details: [] }).mockResolvedValue({ ok: true, id: "0192f000-0000-7000-8000-000000000003" });
    let answer!: (value: { token: string }) => void;
    const requestStepUp = vi.fn(() => new Promise<{ token: string }>((resolve) => (answer = resolve)));
    setup({ save, requestStepUp });
    fireEvent.change(field("Número"), { target: { value: "900373115" } });
    fireEvent.change(field("Razón social"), { target: { value: "Café del Norte S.A.S." } });
    fireEvent.keyDown(field("Razón social"), { key: "s", ctrlKey: true });
    const code = await screen.findByLabelText("Código de 6 dígitos");
    expect(save).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field("Razón social"), { key: "s", ctrlKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    // Verifying: the code is sent and the token is on its way.
    fireEvent.change(code, { target: { value: "123456" } });
    expect(requestStepUp).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field("Razón social"), { key: "Enter", metaKey: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Crear" }) as HTMLButtonElement).disabled).toBe(true);
    answer({ token: "tok-2" });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![1]).toBe("tok-2");
  });
});
