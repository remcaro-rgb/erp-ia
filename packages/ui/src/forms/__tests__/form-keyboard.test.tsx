// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderEs } from "../../shell/__tests__/intl";
import { RecordForm, SelectField, TextField } from "../form-parts";

afterEach(cleanup);

// Enter moves to the next field of a record form (OD-11): Shift+Enter back, Ctrl/⌘+Enter saves, Enter on the last field
// stays put, a textarea keeps its newline, and the browser's implicit submit never fires.

const options = [
  { code: "A", name: "Alfa" },
  { code: "B", name: "Beta" },
];

function setup(canSave = true) {
  const onSave = vi.fn();
  const onSubmit = vi.fn((e: Event) => e.preventDefault());
  renderEs(
    <RecordForm canSave={canSave} onSave={onSave} failure={null}>
      <TextField label="Uno" value="" onChange={() => {}} />
      <TextField label="Bloqueado" value="" disabled onChange={() => {}} />
      <label>
        Calculado
        <input readOnly value="x" />
      </label>
      <TextField label="Dos" value="" onChange={() => {}} />
      <SelectField label="Lista" value="A" options={options} onChange={() => {}} />
      <label>
        Notas
        <textarea />
      </label>
      <label>
        Marca
        <input type="checkbox" />
      </label>
      <TextField label="Último" value="" onChange={() => {}} />
    </RecordForm>,
  );
  document.querySelector("form")!.addEventListener("submit", onSubmit);
  return { onSave, onSubmit };
}

const get = (label: string) => screen.getByLabelText(label) as HTMLElement;
const enter = (el: HTMLElement, init: KeyboardEventInit = {}) => fireEvent.keyDown(el, { key: "Enter", ...init });

describe("Enter moves through a record form", () => {
  it("goes to the next field in DOM order, skipping disabled and read-only ones, and is not a submit", () => {
    const { onSave, onSubmit } = setup();
    get("Uno").focus();
    // fireEvent returns false when the handler called preventDefault.
    expect(enter(get("Uno"))).toBe(false);
    expect(document.activeElement).toBe(get("Dos"));
    enter(get("Dos"));
    expect(document.activeElement).toBe(get("Lista"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("an Enter on a closed select also moves on", () => {
    setup();
    get("Lista").focus();
    expect(enter(get("Lista"))).toBe(false);
    expect(document.activeElement).toBe(get("Notas"));
  });

  it("a textarea keeps Enter for its newline", () => {
    setup();
    get("Notas").focus();
    expect(enter(get("Notas"))).toBe(true);
    expect(document.activeElement).toBe(get("Notas"));
  });

  it("Shift+Enter goes back", () => {
    setup();
    get("Dos").focus();
    expect(enter(get("Dos"), { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(get("Uno"));
  });

  it("a checkbox is a field too", () => {
    setup();
    get("Marca").focus();
    enter(get("Marca"), { shiftKey: true });
    expect(document.activeElement).toBe(get("Notas"));
    get("Marca").focus();
    enter(get("Marca"));
    expect(document.activeElement).toBe(get("Último"));
  });

  it("on the last field, and Shift+Enter on the first, keep the focus and still do not submit", () => {
    const { onSave, onSubmit } = setup();
    get("Último").focus();
    expect(enter(get("Último"))).toBe(false);
    expect(document.activeElement).toBe(get("Último"));
    get("Uno").focus();
    expect(enter(get("Uno"), { shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(get("Uno"));
    expect(onSave).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter and ⌘+Enter save; a form that cannot save does not", () => {
    const { onSave } = setup();
    enter(get("Uno"), { ctrlKey: true });
    enter(get("Notas"), { metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(2);
    cleanup();
    const blocked = setup(false);
    enter(get("Uno"), { ctrlKey: true });
    expect(blocked.onSave).not.toHaveBeenCalled();
  });

  it("leaves an Enter that a widget already handled (an open list choosing an option)", () => {
    setup();
    const uno = get("Uno");
    uno.addEventListener("keydown", (e) => e.preventDefault());
    get("Uno").focus();
    enter(uno);
    expect(document.activeElement).toBe(get("Uno"));
  });

  it("does not move on while an input says its list is open", () => {
    setup();
    get("Uno").setAttribute("aria-expanded", "true");
    get("Uno").focus();
    enter(get("Uno"));
    expect(document.activeElement).toBe(get("Uno"));
  });
});
