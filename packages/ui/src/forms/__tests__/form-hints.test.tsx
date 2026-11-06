// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { Field, RecordForm, SelectField, TextField } from "../form-parts";

afterEach(cleanup);

// Owner 2026-11-05 (replaces OD-12's switch): the DIAN codes always show before a list's names, the forms have no
// "Ver códigos DIAN" switch, and a hint is plain help for the person (never an XML/UBL field name).

const tables = [
  { code: "05", name: "Antioquia" },
  { code: "11", name: "Bogotá, D.C." },
];

function form() {
  return (
    <RecordForm canSave onSave={() => {}} failure={null}>
      <SelectField label="Departamento" value="05" options={tables} onChange={() => {}} />
      <SelectField label="Relación" value="05" options={tables} showCode={false} onChange={() => {}} />
      <TextField label="Número" hint="solo dígitos" value="" onChange={() => {}} />
      <Field label="Libre" hint="ayuda libre">
        {(id) => <input id={id} />}
      </Field>
    </RecordForm>
  );
}

describe("DIAN codes and hints", () => {
  it("shows the code before each name, has no switch, and keeps the help hints", () => {
    renderEs(form());
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getAllByRole("option", { name: "05 · Antioquia" })).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Antioquia" })).toBeTruthy();
    expect(screen.getByText("solo dígitos")).toBeTruthy();
    expect(screen.getByText("ayuda libre")).toBeTruthy();
  });

  it("describes a control by its hint, and only when it has one", () => {
    renderEs(form());
    expect(screen.getByLabelText("Departamento").getAttribute("aria-describedby")).toBeNull();
    expect(screen.getByLabelText(/^Número/).getAttribute("aria-describedby")).toBeTruthy();
  });

  it("Shift+Enter on the first field keeps the caret there", () => {
    renderEs(form());
    const first = screen.getByLabelText("Departamento");
    first.focus();
    fireEvent.keyDown(first, { key: "Enter", shiftKey: true });
    expect(document.activeElement).toBe(first);
  });
});
