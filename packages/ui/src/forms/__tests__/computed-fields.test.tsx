// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { ComputedField } from "../computed-field";
import { RecordForm } from "../form-parts";
import { PartyForm } from "../PartyForm";
import type { PartyTables } from "../party-form-model";

afterEach(cleanup);

// M12: a computed value (the check digit, the name on the document) is readable and copyable: `readOnly`, never
// `disabled`, with a copy button that says "Copiado".

const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
beforeEach(() => {
  writeText.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

describe("ComputedField", () => {
  it("is a read-only box (not disabled) that copies its value and announces it", async () => {
    renderEs(
      <RecordForm canSave onSave={() => {}} failure={null}>
        <ComputedField label="Margen" value="38 %" copyLabel="Margen" />
      </RecordForm>,
    );
    const box = screen.getByLabelText("Margen", { selector: "input" }) as HTMLInputElement;
    expect(box.readOnly).toBe(true);
    expect(box.disabled).toBe(false);
    expect(box.className).toContain("erp-input--computed");
    expect(box.value).toBe("38 %");
    expect(screen.queryByText("Copiado")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copiar Margen" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("38 %"));
    // A polite live region that was already in the page, so the change is announced.
    const live = await screen.findByText("Copiado");
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("has nothing to copy while the value is empty", () => {
    renderEs(
      <RecordForm canSave onSave={() => {}} failure={null}>
        <ComputedField label="DV" value="" copyLabel="DV" />
      </RecordForm>,
    );
    expect((screen.getByRole("button", { name: "Copiar DV" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says nothing when the clipboard refuses", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    renderEs(
      <RecordForm canSave onSave={() => {}} failure={null}>
        <ComputedField label="DV" value="3" copyLabel="DV" />
      </RecordForm>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copiar DV" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByText("Copiado")).toBeNull();
  });
});

const tables: PartyTables = {
  documentTypes: [
    { code: "13", name: "Cédula de ciudadanía", charset: "num", maxLength: 10, personTypes: ["2"], foreign: false },
    { code: "31", name: "NIT", charset: "num", maxLength: 10, personTypes: ["1", "2"], foreign: false },
  ],
  responsibilities: [{ code: "O-13", name: "Gran contribuyente" }],
  exclusiveResponsibility: "R-99-PN",
  taxSchemes: [{ code: "01", name: "IVA" }],
  countries: [{ code: "CO", name: "Colombia" }],
  homeCountry: "CO",
  departments: [{ code: "05", name: "Antioquia" }],
  municipalities: [{ code: "05001", name: "Medellín", departmentCode: "05" }],
  checkDigitTypes: ["31"],
  preferredDocumentType: { home: { "1": "31", "2": "13" }, abroad: { "1": "50", "2": "41" } },
  limits: { legalName: 450, namePart: 60, address: 200 },
};

describe("PartyForm computed fields", () => {
  it("the check digit is read-only and copyable, and so is the NIT line of the RUT summary", async () => {
    renderEs(<PartyForm record={null} tables={tables} modes={{}} save={async () => ({ ok: true, id: "x" })} />);
    fireEvent.change(screen.getByLabelText(/^Número/), { target: { value: "900373115" } });
    const dv = screen.getByLabelText("DV", { selector: "input" }) as HTMLInputElement;
    expect(dv.value).toBe("3");
    expect(dv.readOnly).toBe(true);
    expect(dv.disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Copiar DV" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("3"));
    fireEvent.click(screen.getByRole("button", { name: "Copiar identificación" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("NIT 900373115-3"));
  });

  it("the name on the document of a natural person is read-only and copyable", async () => {
    renderEs(<PartyForm record={null} tables={tables} modes={{}} save={async () => ({ ok: true, id: "x" })} />);
    fireEvent.change(screen.getByLabelText("Tipo de persona"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/^Primer apellido/), { target: { value: "Gómez" } });
    fireEvent.change(screen.getByLabelText(/^Primer nombre/), { target: { value: "Ana" } });
    const name = screen.getByLabelText(/^Nombre para documentos/, { selector: "input" }) as HTMLInputElement;
    expect(name.readOnly).toBe(true);
    expect(name.disabled).toBe(false);
    expect(name.value).toContain("Gómez");
    fireEvent.click(screen.getByRole("button", { name: "Copiar Nombre para documentos" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(name.value));
  });
});
