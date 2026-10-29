// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { FormPrefsProvider } from "../form-context";
import { Field, RecordForm, SelectField, TextField } from "../form-parts";

afterEach(cleanup);

// "Ver códigos DIAN" (OD-12): schema annotations and the code before a name hide by default; help hints always show.

const tables = [
  { code: "05", name: "Antioquia" },
  { code: "11", name: "Bogotá, D.C." },
];

function form() {
  return (
    <RecordForm canSave onSave={() => {}} failure={null}>
      <SelectField label="Departamento" hint="DANE" hintKind="dian" value="05" options={tables} onChange={() => {}} />
      <TextField label="Número" hint="solo dígitos" value="" onChange={() => {}} />
      <TextField label="Marca" hint="BrandName" hintKind="dian" value="" onChange={() => {}} />
      <Field label="Libre" hint="ayuda libre">
        {(id) => <input id={id} />}
      </Field>
    </RecordForm>
  );
}

describe("DIAN hints toggle", () => {
  it("is off by default: no DIAN hint, no code before a name, help hints stay", () => {
    renderEs(form());
    const toggle = screen.getByRole("switch", { name: "Ver códigos DIAN" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByText("DANE")).toBeNull();
    expect(screen.queryByText("BrandName")).toBeNull();
    expect(screen.getByText("solo dígitos")).toBeTruthy();
    expect(screen.getByText("ayuda libre")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Antioquia" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "05 · Antioquia" })).toBeNull();
  });

  it("shows the DIAN hints and the codes when turned on, and hides them again", () => {
    renderEs(form());
    const toggle = screen.getByRole("switch", { name: "Ver códigos DIAN" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("DANE")).toBeTruthy();
    expect(screen.getByText("BrandName")).toBeTruthy();
    expect(screen.getByRole("option", { name: "05 · Antioquia" })).toBeTruthy();
    expect(screen.getByLabelText(/^Departamento/).getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText("DANE")).toBeNull();
  });

  it("describes a control by its hint only while the hint is shown", () => {
    renderEs(form());
    expect(screen.getByLabelText("Departamento").getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByLabelText(/^Número/).getAttribute("aria-describedby")).toBeTruthy();
  });

  it("follows the user's preference when the shell provides it, and writes it back", () => {
    const setDianHints = vi.fn();
    renderEs(
      <FormPrefsProvider value={{ dianHints: true, setDianHints }}>{form()}</FormPrefsProvider>,
    );
    const toggle = screen.getByRole("switch", { name: "Ver códigos DIAN" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("DANE")).toBeTruthy();
    fireEvent.click(toggle);
    expect(setDianHints).toHaveBeenCalledWith(false);
  });

  it("the switch is not a field of the Enter order", () => {
    renderEs(form());
    const first = screen.getByLabelText("Departamento");
    first.focus();
    fireEvent.keyDown(first, { key: "Enter", shiftKey: true });
    expect(document.activeElement).toBe(first);
  });
});
