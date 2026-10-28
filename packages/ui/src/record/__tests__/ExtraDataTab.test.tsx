// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExtraDataTab, extraTabCounts, type ExtraFieldDef } from "../../index";

afterEach(cleanup);

const def = (over: Partial<ExtraFieldDef> & Pick<ExtraFieldDef, "key" | "label" | "type">): ExtraFieldDef => ({
  maxLength: null,
  required: false,
  options: null,
  canEnter: true,
  canEdit: true,
  canView: true,
  ...over,
});

const defs: ExtraFieldDef[] = [
  def({ key: "sitio_web", label: "Sitio web", type: "url", maxLength: 120 }),
  def({ key: "dia_pago", label: "Día de pago habitual", type: "number", maxLength: 2, required: true }),
  def({ key: "canal", label: "Canal comercial", type: "list", options: ["Retail", "HORECA"] }),
  def({ key: "activo", label: "Cliente activo", type: "bool" }),
  def({ key: "desde", label: "Cliente desde", type: "date" }),
];

const setup = (props: Partial<Parameters<typeof ExtraDataTab>[0]> = {}) => {
  const onChange = vi.fn();
  render(<ExtraDataTab defs={defs} extra={{}} extraFree={[]} onChange={onChange} {...props} />);
  return onChange;
};

describe("ExtraDataTab", () => {
  it("renders each defined field with its type, limits and the obligatorio mark", () => {
    setup();
    expect(screen.getByLabelText(/^Sitio web/)).toBeTruthy();
    expect(screen.getByText("obligatorio")).toBeTruthy();
    expect((screen.getByLabelText(/^Canal comercial/) as HTMLSelectElement).options.length).toBe(3);
    expect((screen.getByLabelText(/^Sitio web/) as HTMLInputElement).maxLength).toBe(120);
    expect((screen.getByLabelText(/^Cliente desde/) as HTMLInputElement).type).toBe("date");
    expect(screen.getByText(/URL · máx\. 120/)).toBeTruthy();
  });

  it("reports the whole extra document on change and drops a cleared key", () => {
    const onChange = setup({ extra: { sitio_web: "https://a.co", canal: "Retail" } });
    fireEvent.change(screen.getByLabelText(/^Día de pago/), { target: { value: "15" } });
    expect(onChange).toHaveBeenLastCalledWith({ extra: { sitio_web: "https://a.co", canal: "Retail", dia_pago: "15" }, extraFree: [] });
    fireEvent.change(screen.getByLabelText(/^Sitio web/), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith({ extra: { canal: "Retail" }, extraFree: [] });
    fireEvent.change(screen.getByLabelText(/^Canal comercial/), { target: { value: "HORECA" } });
    expect(onChange).toHaveBeenLastCalledWith({ extra: { sitio_web: "https://a.co", canal: "HORECA" }, extraFree: [] });
    fireEvent.change(screen.getByLabelText(/^Cliente activo/), { target: { value: "Sí" } });
    expect(onChange).toHaveBeenLastCalledWith({ extra: { sitio_web: "https://a.co", canal: "Retail", activo: true }, extraFree: [] });
  });

  it("flags a value that does not fit its type, and an empty required field only as pending", () => {
    setup({ extra: { dia_pago: "quince", sitio_web: "cafe.co" } });
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent);
    expect(alerts).toContain("Debe ser un número");
    expect(alerts).toContain("URL con http(s)://");
    cleanup();
    setup({ extra: {} });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("obligatorio")).toBeTruthy();
  });

  it("a role that cannot enter an empty field, or edit a filled one, sees it read-only", () => {
    setup({
      defs: [
        def({ key: "origen", label: "Origen", type: "text", canEnter: false, canEdit: true }),
        def({ key: "lote", label: "Lote", type: "text", canEnter: true, canEdit: false }),
      ],
      extra: { lote: "L-1" },
    });
    expect((screen.getByLabelText(/^Origen/) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/^Lote/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText(/solo lectura para tu rol/)).toHaveLength(2);
  });

  it("a role that cannot view a field sees a masked, disabled input and never its value", () => {
    setup({ defs: [def({ key: "dia_pago", label: "Día de pago habitual", type: "number", canView: false })], extra: { dia_pago: "15" } });
    const masked = screen.getByLabelText("Día de pago habitual") as HTMLInputElement;
    expect(masked.disabled).toBe(true);
    expect(masked.value).toBe("••••••");
    expect(masked.title).toBe("Tu rol no puede ver este dato");
    expect(screen.queryByDisplayValue("15")).toBeNull();
  });

  it("edits the free name / value pairs: add, change and remove", () => {
    const onChange = setup({ defs: [], extraFree: [{ name: "Nota", value: "Paga los viernes" }] });
    expect(screen.getByText(/no ha definido datos adicionales/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "+ Agregar dato" }));
    expect(onChange).toHaveBeenLastCalledWith({ extra: {}, extraFree: [{ name: "Nota", value: "Paga los viernes" }, { name: "", value: "" }] });
    fireEvent.change(screen.getByDisplayValue("Paga los viernes"), { target: { value: "Paga los lunes" } });
    expect(onChange).toHaveBeenLastCalledWith({ extra: {}, extraFree: [{ name: "Nota", value: "Paga los lunes" }] });
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    expect(onChange).toHaveBeenLastCalledWith({ extra: {}, extraFree: [] });
  });

  it("keeps free texts to 200 characters", () => {
    setup({ defs: [], extraFree: [{ name: "a", value: "b" }] });
    for (const input of screen.getAllByRole("textbox")) expect((input as HTMLInputElement).maxLength).toBe(200);
  });

  it("is read-only when asked", () => {
    setup({ readOnly: true, extra: { sitio_web: "https://a.co" }, extraFree: [{ name: "Nota", value: "x" }] });
    for (const input of screen.getAllByRole("textbox")) expect((input as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "+ Agregar dato" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Quitar" })).toBeNull();
  });
});

describe("extraTabCounts", () => {
  it("counts defined fields plus free data, and the invalid or required-and-empty values as pending", () => {
    expect(extraTabCounts(defs, {}, [{ name: "a", value: "b" }])).toEqual({ count: 6, warn: 1 });
    expect(extraTabCounts(defs, { dia_pago: "x", sitio_web: "ftp" }, [])).toEqual({ count: 5, warn: 2 });
    expect(extraTabCounts(defs, { dia_pago: "15" }, [])).toEqual({ count: 5, warn: 0 });
    // A field the caller cannot see is not the caller's pending item.
    expect(extraTabCounts([def({ key: "k", label: "K", type: "text", required: true, canView: false })], {}, [])).toEqual({ count: 1, warn: 0 });
  });
});
